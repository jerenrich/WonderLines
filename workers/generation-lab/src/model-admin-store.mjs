import {parseModelRegistry, MODEL_REGISTRY_KEY} from '../../coloring-sheets-api/src/model-registry.mjs';
import {ADMIN_EMAIL} from './admin-auth.mjs';

const json = (value, status=200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
const fail = (message, status=400, code='invalid_request') => json({error:{message,code}},status);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
const historyKey = sequence => 'history:'+String(sequence).padStart(16,'0');
const metadata = record => { const {document, ...rest}=record; return rest; };

export function validateCatalogue(document) {
  const issues=[];
  let effective;
  try {
    const raw=JSON.stringify(document);
    if (!raw || new TextEncoder().encode(raw).length>65536) throw new Error('Catalogue must be at most 64 KiB.');
    effective=parseModelRegistry(document);
  } catch(error) { issues.push({path:'catalogue',message:error.message}); }
  // Give row-level feedback while keeping the production parser authoritative.
  if (Array.isArray(document?.models)) {
    const seen=new Set();
    document.models.forEach((model,index)=>{
      if(seen.has(model?.id))issues.push({path:`models[${index}].id`,message:'Model IDs must be unique.'});
      seen.add(model?.id);
      try { parseModelRegistry({...document,defaultModel:model?.id,models:[model]}); }
      catch(error) { issues.push({path:`models[${index}]`,message:error.message}); }
    });
  }
  const warnings=[];
  if(effective && effective.models.length===0)warnings.push('No models will appear in the app. Disable every provider to pause all new generation, including explicit requests.');
  if(effective && effective.defaultModel!==document.defaultModel)warnings.push('The selected default is unavailable; the first available visible model will be used.');
  return {valid:issues.length===0,issues,warnings,...(effective?{defaultModel:effective.defaultModel,visibleCount:effective.models.length,enabledCount:Object.keys(effective.routes).length}:{})};
}
export function catalogueChanges(before,after) {
  const changes=[];
  if(before.defaultModel!==after.defaultModel)changes.push('Default model changed.');
  for(const provider of new Set([...Object.keys(before.providers),...Object.keys(after.providers)])) {
    if(before.providers[provider]?.enabled!==after.providers[provider]?.enabled)changes.push(`${provider}: ${after.providers[provider]?.enabled?'enabled':'disabled'}.`);
  }
  const previous=new Map(before.models.map(model=>[model.id,model]));
  for(const model of after.models) {
    const old=previous.get(model.id);
    if(!old)changes.push(`${model.label}: added.`);
    else if(canonical(old)!==canonical(model))changes.push(`${model.label}: settings updated.`);
    previous.delete(model.id);
  }
  for(const model of previous.values())changes.push(`${model.label}: removed.`);
  if(before.models.map(model=>model.id).join('\n')!==after.models.map(model=>model.id).join('\n'))changes.push('Picker order changed.');
  return changes;
}

// A single control-plane object serializes admin writes and retains immutable
// snapshots. Apps still read KV directly; this object is never on generation's
// request path. A durable outbox makes publishing recoverable across restarts.
export class ModelCatalogueAdmin {
  constructor(state,env,{now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
    this.state=state;this.env=env;this.now=now;this.sleep=sleep;this.queue=Promise.resolve();
  }
  serial(operation) {const result=this.queue.then(operation);this.queue=result.catch(()=>{});return result;}
  fetch(request) {
    return this.serial(async()=>{
      try{return await this.handle(request);}
      catch {console.error(JSON.stringify({event:'model_admin_unavailable'}));return fail('Model administration is temporarily unavailable. Your draft has not been discarded.',503,'admin_unavailable');}
    });
  }
  alarm() {return this.serial(async()=>{await this.deliverPending();});}
  async importDocument(document,previous) {
    const record={id:crypto.randomUUID(),sequence:(previous?.sequence??0)+1,revision:document.revision,
      createdAt:new Date(this.now()).toISOString(),action:previous?'external':'baseline',actor:null,
      note:previous?'Observed a direct KV edit.':'Imported the existing live catalogue.',
      restoredFrom:null,operationId:null,document,changes:previous?catalogueChanges(previous.document,document):[]};
    await this.storeRecord(record);
    return record;
  }
  async storeRecord(record) {
    const hash=await digest(record.document);
    await this.state.storage.transaction(async storage=>{
      await storage.put('version:'+record.id,record);
      await storage.put(historyKey(record.sequence),metadata(record));
      await storage.put('digest:'+hash,record.id);
      await storage.put('head',record);
    });
  }
  async current() {
    let head=await this.state.storage.get('head');
    const pending=await this.state.storage.get('pending');
    if(pending)return {head,pending:metadata(pending.record),warning:'A catalogue change is still publishing. New edits are paused until it finishes.'};
    let document;
    try {
      const raw=await this.env.MODEL_REGISTRY.get(MODEL_REGISTRY_KEY,{type:'text',cacheTtl:60});
      if(typeof raw!=='string'||new TextEncoder().encode(raw).length>65536)throw new Error('Missing catalogue');
      document=JSON.parse(raw);parseModelRegistry(document);
    } catch {
      if(!head)throw new Error('Initial catalogue unavailable');
      return {head,pending:null,warning:'The live KV catalogue could not be read or validated. The last recorded version is shown; publishing or restoring a valid version can repair it.'};
    }
    if(!head)return {head:await this.importDocument(document),pending:null,warning:null};
    if(canonical(document)!==canonical(head.document)) {
      // An already-known snapshot may be a stale KV cache. Unseen edits are
      // imported so dashboard/CLI edits with a fresh revision enter the audit.
      const known=await this.state.storage.get('digest:'+await digest(document));
      if(!known)head=await this.importDocument(document,head);
    }
    return {head,pending:null,warning:null};
  }
  async deliverPending() {
    const pending=await this.state.storage.get('pending');
    if(!pending)return true;
    try {
      // KV permits one write per second to a key. Persist the attempt time so
      // an immediate retry/restart cannot cause a tight publication loop.
      const last=await this.state.storage.get('lastAttemptAt')??0;
      const delay=1100-(this.now()-last);
      if(delay>0)await this.sleep(delay);
      await this.state.storage.put('lastAttemptAt',this.now());
      await this.env.MODEL_REGISTRY.put(MODEL_REGISTRY_KEY,JSON.stringify(pending.record.document));
      await this.state.storage.transaction(async storage=>{
        const record=pending.record;
        await storage.put('head',record);
        await storage.put('version:'+record.id,record);
        await storage.put(historyKey(record.sequence),metadata(record));
        await storage.put('digest:'+await digest(record.document),record.id);
        await storage.delete('pending');
      });
      console.info(JSON.stringify({event:'model_catalogue_published',versionID:pending.record.id,action:pending.record.action}));
      return true;
    } catch {
      await this.state.storage.setAlarm(this.now()+15000);
      console.error(JSON.stringify({event:'model_catalogue_publication_pending',versionID:pending.record.id}));
      return false;
    }
  }
  async statusFor(operation) {
    if(!operation)return fail('Unknown change request.',404);
    const pending=await this.state.storage.get('pending');
    const record=await this.state.storage.get('version:'+operation.versionId);
    return json({status:pending?.record.id===operation.versionId?'publishing':'published',version:metadata(record)});
  }
  async handle(request) {
    const path=new URL(request.url).pathname;
    const input=await request.json();
    // This actor is constructed from the verified server-side Google session,
    // never forwarded from a browser request body by the public API handler.
    if(input?.actor?.email!==ADMIN_EMAIL||typeof input.actor.id!=='string'||!input.actor.id||input.actor.id.length>255)return fail('Administrator access is required.',403,'forbidden');
    await this.deliverPending();
    const current=await this.current();
    if(path==='/current')return json(current);
    if(path==='/history') {
      if(input.before!==undefined&&(!Number.isSafeInteger(input.before)||input.before<1))return fail('Invalid history cursor.');
      const rows=await this.state.storage.list({prefix:'history:',reverse:true,limit:21,...(input.before?{end:historyKey(input.before)}:{})});
      const values=[...rows.values()];
      return json({versions:values.slice(0,20),nextCursor:values.length>20?values[19].sequence:null,currentVersion:current.head.id});
    }
    if(path==='/version') {
      if(!uuid(input.id))return fail('Invalid version ID.');
      const record=await this.state.storage.get('version:'+input.id);
      return record?json({version:record}):fail('This version could not be found.',404);
    }
    if(path==='/operation') {
      if(!uuid(input.id))return fail('Invalid change request ID.');
      return this.statusFor(await this.state.storage.get('operation:'+input.id));
    }
    if(path==='/validate') {
      const result=validateCatalogue(input.document);
      return json({...result,changes:result.valid?catalogueChanges(current.head.document,input.document):[],currentVersion:current.head.id});
    }
    if(!['/publish','/rollback'].includes(path))return fail('Not found.',404);
    if(!uuid(input.requestId)||!uuid(input.baseVersion))return fail('Reload the current catalogue before changing it.');
    const fingerprint=await digest({path,baseVersion:input.baseVersion,document:input.document??null,targetVersion:input.targetVersion??null,note:input.note??null,actor:input.actor});
    const existing=await this.state.storage.get('operation:'+input.requestId);
    if(existing)return existing.fingerprint===fingerprint?this.statusFor(existing):fail('This change request ID was already used.',409,'idempotency_conflict');
    if(current.pending)return fail('Another change is still publishing. Check its status before making another edit.',409,'publication_pending');
    if(input.baseVersion!==current.head.id)return fail('The catalogue changed in another tab. Reload the current version before publishing.',409,'version_conflict');
    let document,note,restoredFrom=null;
    if(path==='/rollback') {
      if(!uuid(input.targetVersion))return fail('Choose a valid version to restore.');
      const target=await this.state.storage.get('version:'+input.targetVersion);
      if(!target)return fail('This version could not be found.',404);
      if(target.id===current.head.id)return fail('This version is already current.',409);
      document=structuredClone(target.document);restoredFrom=target.id;
      note='Restored version '+target.revision;
    } else {
      document=input.document;note=input.note;
      if(typeof note!=='string'||!note.trim()||note.length>200||/[\x00-\x1f]/.test(note))return fail('Add a change note of 1–200 characters.');
      note=note.trim();
    }
    const validation=validateCatalogue(document);
    if(!validation.valid)return json({error:{code:'validation_failed',message:'The catalogue has validation errors.'},...validation},400);
    const id=crypto.randomUUID();
    document={...structuredClone(document),revision:'admin-'+id};
    const record={id,sequence:current.head.sequence+1,revision:document.revision,createdAt:new Date(this.now()).toISOString(),
      action:path==='/rollback'?'rollback':'publish',actor:input.actor,note,restoredFrom,operationId:input.requestId,
      document,changes:catalogueChanges(current.head.document,document)};
    // Schedule before persisting the outbox: a crash at any later point has an
    // alarm to finish delivery. A crash before persistence leaves a harmless wake.
    await this.state.storage.setAlarm(this.now()+5000);
    await this.state.storage.transaction(async storage=>{
      await storage.put('pending',{record});
      await storage.put('version:'+id,record);
      await storage.put('operation:'+input.requestId,{versionId:id,fingerprint});
    });
    const delivered=await this.deliverPending();
    return json({status:delivered?'published':'publishing',version:metadata(record)},delivered?200:202);
  }
}
