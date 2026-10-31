import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SignJWT} from 'jose';
import {ModelCatalogueAdmin,validateCatalogue} from '../src/model-admin-store.mjs';
import {ADMIN_EMAIL} from '../src/admin-auth.mjs';
import worker from '../src/index.mjs';
const seed=JSON.parse(await readFile(new URL('../../coloring-sheets-api/model-registry.initial.json',import.meta.url)));
const actor={id:'verified-google-subject',email:ADMIN_EMAIL};
class Storage {
  values=new Map();alarm=null;transactions=0;failTransaction=null;
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async delete(key){return this.values.delete(key);}
  async setAlarm(time){this.alarm=time;}
  async list({prefix='',limit=Infinity,reverse=false,end}={}){
    let values=[...this.values].filter(([key])=>key.startsWith(prefix)&&(!end||key<end)).sort(([a],[b])=>a.localeCompare(b));
    if(reverse)values.reverse();return new Map(values.slice(0,limit).map(([key,value])=>[key,structuredClone(value)]));
  }
  async transaction(callback){
    const before=structuredClone(this.values);this.transactions++;
    try{const result=await callback(this);if(this.transactions===this.failTransaction)throw new Error('Synthetic storage commit failure');return result;}
    catch(error){this.values=before;throw error;}
  }
}
let clock=Date.now();
const options={now:()=>clock,sleep:async ms=>{clock+=ms;}};
const make=()=>{
  const kv={value:JSON.stringify(seed),puts:0,fail:false,failRead:false,stale:null,
    async get(){if(this.failRead)throw new Error('Synthetic read failure');return this.stale??this.value;},
    async put(key,value){assert.equal(key,'catalogue:v1');this.puts++;if(this.fail)throw new Error('Synthetic write failure');this.value=value;}};
  const storage=new Storage(),env={MODEL_REGISTRY:kv};return {kv,storage,env,store:new ModelCatalogueAdmin({storage},env,options)};
};
const invoke=async(store,path,input={})=>{
  const response=await store.fetch(new Request('https://internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor,...input})}));
  return {status:response.status,data:await response.json()};
};
const setup=make();
let result=await invoke(setup.store,'/current');assert.equal(result.status,200);
const baseline=result.data.head;
assert.deepEqual(baseline.document,seed);assert.equal(baseline.action,'baseline');assert.equal(setup.kv.puts,0);
assert.equal((await invoke(setup.store,'/current')).data.head.id,baseline.id);
assert.equal((await invoke(setup.store,'/history')).data.versions.length,1);
assert.equal((await invoke(setup.store,'/current',{actor:{id:'other',email:'other@gmail.com'}})).status,403);
assert.equal(validateCatalogue(seed).valid,true);
const bad=structuredClone(seed);bad.models[0].price.usd=-1;
result=await invoke(setup.store,'/validate',{document:bad});assert.equal(result.data.valid,false);assert.ok(result.data.issues.some(issue=>issue.path==='models[0]'));
assert.equal(validateCatalogue({...seed,models:[seed.models[0],seed.models[0]]}).valid,false);
const pause=structuredClone(seed);for(const provider of Object.values(pause.providers))provider.enabled=false;
assert.equal(validateCatalogue(pause).valid,true);assert.ok(validateCatalogue(pause).warnings.length);
assert.equal(validateCatalogue({...seed,revision:'x'.repeat(70000)}).valid,false);
const draft=structuredClone(seed);draft.models[0].enabled=false;
let request={document:draft,baseVersion:baseline.id,requestId:crypto.randomUUID(),note:'Pause Flare'};
const beforeInvalid=setup.kv.puts;
result=await invoke(setup.store,'/publish',{...request,document:bad});assert.equal(result.status,400);assert.equal(setup.kv.puts,beforeInvalid);
result=await invoke(setup.store,'/publish',{...request,note:''});assert.equal(result.status,400);
result=await invoke(setup.store,'/publish',request);assert.equal(result.status,200);assert.equal(result.data.status,'published');
const published=result.data.version;
assert.equal(published.actor.id,actor.id);assert.equal(published.actor.email,ADMIN_EMAIL);assert.equal(published.action,'publish');
assert.notEqual(published.revision,seed.revision);assert.equal(JSON.parse(setup.kv.value).models[0].enabled,false);
assert.equal((await invoke(setup.store,'/version',{id:baseline.id})).data.version.document.models[0].enabled,true,'Old versions are immutable.');
const putsAfter=setup.kv.puts;
result=await invoke(setup.store,'/publish',request);assert.equal(result.data.version.id,published.id);assert.equal(setup.kv.puts,putsAfter,'A repeated request never republishes.');
assert.equal((await invoke(setup.store,'/publish',{...request,note:'Different note'})).status,409);
assert.equal((await invoke(setup.store,'/publish',{...request,requestId:crypto.randomUUID()})).data.error.code,'version_conflict');
// KV serving a previous cache must not roll the coordinator's current version back.
setup.kv.stale=JSON.stringify(seed);
assert.equal((await invoke(setup.store,'/current')).data.head.id,published.id);
setup.kv.stale=null;
result=await invoke(setup.store,'/rollback',{targetVersion:baseline.id,baseVersion:published.id,requestId:crypto.randomUUID()});
assert.equal(result.status,200);const restored=result.data.version;
assert.equal(restored.action,'rollback');assert.equal(restored.restoredFrom,baseline.id);assert.notEqual(restored.id,baseline.id);
const restoredDocument=JSON.parse(setup.kv.value);assert.equal(restoredDocument.models[0].enabled,true);assert.notEqual(restoredDocument.revision,seed.revision);
assert.equal((await invoke(setup.store,'/history')).data.versions.length,3);
// A direct edit with a fresh revision is recorded before stale tabs can publish.
const external=JSON.parse(setup.kv.value);external.revision='dashboard-edit';external.models[1].label='External label';setup.kv.value=JSON.stringify(external);
result=await invoke(setup.store,'/current');assert.equal(result.data.head.action,'external');assert.equal(result.data.head.actor,null);
assert.equal(result.data.head.document.models[1].label,'External label');
assert.equal((await invoke(setup.store,'/publish',{...request,baseVersion:restored.id,requestId:crypto.randomUUID()})).data.error.code,'version_conflict');
const head=result.data.head;
const concurrent=await Promise.all([invoke(setup.store,'/publish',{document:head.document,baseVersion:head.id,requestId:crypto.randomUUID(),note:'First tab'}),invoke(setup.store,'/publish',{document:head.document,baseVersion:head.id,requestId:crypto.randomUUID(),note:'Second tab'})]);
assert.deepEqual(concurrent.map(response=>response.status),[200,409]);

// Failed/ambiguous KV delivery survives object restart and preserves the receipt.
for(const failure of ['kv','storage']){
  const test=make();const old=(await invoke(test.store,'/current')).data.head;
  if(failure==='kv')test.kv.fail=true;
  else test.storage.failTransaction=test.storage.transactions+2;
  const input={document:draft,baseVersion:old.id,requestId:crypto.randomUUID(),note:'Recoverable publication'};
  result=await invoke(test.store,'/publish',input);assert.equal(result.status,202);assert.equal(result.data.status,'publishing');
  const pendingId=result.data.version.id;assert.ok(test.storage.alarm);
  assert.equal((await test.storage.get('head')).id,old.id);
  assert.equal((await invoke(test.store,'/operation',{id:input.requestId})).data.version.id,pendingId);
  if(failure==='kv'){
    assert.equal((await invoke(test.store,'/publish',{...input,requestId:crypto.randomUUID()})).data.error.code,'publication_pending');
    test.kv.fail=false;
  }
  const restarted=new ModelCatalogueAdmin({storage:test.storage},test.env,options);
  await restarted.alarm();
  result=await invoke(restarted,'/current');assert.equal(result.data.head.id,pendingId);assert.equal(result.data.pending,null);
  assert.equal((await invoke(restarted,'/history')).data.versions.length,2);
  assert.equal((await invoke(restarted,'/publish',input)).data.version.id,pendingId);
  assert.equal(JSON.parse(test.kv.value).models[0].enabled,false);
}
// History is bounded per response and supports older pages without losing entries.
const pages=make();let pageHead=(await invoke(pages.store,'/current')).data.head;
for(let index=0;index<22;index++){
  const document=structuredClone(pageHead.document);document.models[0].label='Flare '+index;
  result=await invoke(pages.store,'/publish',{document,baseVersion:pageHead.id,requestId:crypto.randomUUID(),note:'Revision '+index});
  assert.equal(result.status,200);pageHead=(await invoke(pages.store,'/current')).data.head;
}
let history=(await invoke(pages.store,'/history')).data;assert.equal(history.versions.length,20);assert.ok(history.nextCursor);
assert.ok(!Object.hasOwn(history.versions[0],'document'));
const next=(await invoke(pages.store,'/history',{before:history.nextCursor})).data;assert.equal(next.versions.length,3);assert.equal(next.nextCursor,null);
assert.equal(new Set([...history.versions,...next.versions].map(version=>version.id)).size,23);
pages.kv.value='invalid JSON';result=await invoke(pages.store,'/current');assert.ok(result.data.warning);assert.equal(result.data.head.id,pageHead.id);
result=await invoke(pages.store,'/rollback',{targetVersion:next.versions.at(-1).id,baseVersion:pageHead.id,requestId:crypto.randomUUID()});assert.equal(result.status,200,'A valid restore can repair a malformed live KV value.');

// Public HTTP boundary authenticates every action and ignores browser actor claims.
const origin='https://admin.example';
const httpEnv={...setup.env,MODEL_ADMIN_ORIGIN:origin,GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-google-secret',MODEL_ADMIN_SESSION_SECRET:'synthetic-admin-session-secret-longer-than-32',MODEL_ADMIN:{idFromName:value=>{assert.equal(value,'model-catalogue-v1');return value;},get:()=>({fetch:(url,options)=>setup.store.fetch(new Request(url,options))})}};
const signed=await new SignJWT({purpose:'session',email:ADMIN_EMAIL}).setProtectedHeader({alg:'HS256'}).setIssuer('wonderlines-model-admin').setAudience(httpEnv.GOOGLE_CLIENT_ID).setSubject('actual-google-subject').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(httpEnv.MODEL_ADMIN_SESSION_SECRET));
const cookie='__Host-wonderlines_admin='+signed;
const http=(path,method='GET',input,extra={})=>worker.fetch(new Request(origin+path,{method,headers:{Cookie:cookie,...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...extra},...(input!==undefined?{body:typeof input==='string'?input:JSON.stringify(input)}:{})}),httpEnv);
let response=await http('/api/admin/models');assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
const current=(await response.json()).head;
response=await http('/api/admin/models/publish','POST',{document:current.document,baseVersion:current.id,requestId:crypto.randomUUID(),note:'HTTP change',actor:{id:'forged-id',email:'other@gmail.com'}});assert.equal(response.status,200);
const version=(await response.json()).version;assert.equal(version.actor.id,'actual-google-subject');assert.equal(version.actor.email,ADMIN_EMAIL);
assert.equal((await http('/api/admin/models/publish','POST',{}, {Origin:'https://evil.example'})).status,403);
assert.equal((await http('/api/admin/models/publish','POST','{')).status,400);
assert.equal((await http('/api/admin/models/publish','POST','x'.repeat(74000))).status,413);
response=await http('/api/admin/models/history');assert.equal(response.status,200);assert.ok(!(await response.text()).includes(httpEnv.MODEL_ADMIN_SESSION_SECRET));
console.log('PASS: validated edits, immutable history, owner attribution, stale-tab conflicts, serialized concurrent writes, one-click rollback, external imports, pagination, durable/idempotent publication recovery and protected HTTP controls; no network.');
