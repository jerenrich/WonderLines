import {catalog, publicJob} from './catalog.mjs';
import {structuredComposition, isUUID} from '../../coloring-sheets-api/src/composition.mjs';
import {generationFingerprints, prepareGeneration, startGeneration} from '../../coloring-sheets-api/src/generation-start.mjs';

const LIMIT = 100;
const json = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const fail = (message,status=400,code='invalid_request') => json({error:{message,code}},status);
const summary = grid => ({id:grid.id,prompt:grid.prompt,createdAt:grid.createdAt,sequence:grid.sequence,models:grid.models,ages:grid.ages,count:grid.cells.length,
  ready:grid.cells.filter(c=>c.status==='completed').length,failed:grid.cells.filter(c=>c.status==='failed').length,
  previews:grid.cells.filter(c=>c.status==='completed').slice(0,4).map(c=>c.id)});

// Mutations, reservations and eviction share a serialized coordinator. Reads
// and upstream status checks do not wait behind network-bound generation starts.
// In-flight images belonging to an evicted grid are cleaned after they finish.
export class ComparisonLibrary {
  constructor(state,env) { this.state=state;this.env=env;this.queue=Promise.resolve(); }
  serial(operation) { const result=this.queue.then(operation);this.queue=result.catch(()=>{});return result; }
  fetch(request) {
    const operation=async()=>{
    try { return await this.handle(request); }
    catch { return fail('The library is temporarily unavailable. Please try again.',503,'library_unavailable'); }
    };
    return ['/list','/get','/lookup','/job'].includes(new URL(request.url).pathname)?operation():this.serial(operation);
  }
  async call(path,input={}) {
    const stub=this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(this.env.LAB_ACCOUNT_ID));
    const response=await stub.fetch('https://account'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    return {status:response.status,value:await response.json()};
  }
  async schedule() { if(await this.state.storage.getAlarm()===null)await this.state.storage.setAlarm(Date.now()+5000); }
  async write(grid) {
    const index=(await this.state.storage.get('index'))??[];
    const next=[summary(grid),...index.filter(g=>g.id!==grid.id)].sort((a,b)=>b.createdAt-a.createdAt||(b.sequence??0)-(a.sequence??0)||b.id.localeCompare(a.id));
    await this.state.storage.transaction(async storage=>{await storage.put('grid:'+grid.id,grid);await storage.put('index',next);});
  }
  normalize(input) {
    if(!input||!isUUID(input.id)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>240||!Array.isArray(input.models)||!Array.isArray(input.ages)||!Array.isArray(input.cells)||!input.cells.length||input.cells.length>80)return null;
    const models=input.models.map(m=>catalog(this.env).find(x=>x.id===m?.id));
    const ages=input.ages;
    if(models.some(m=>!m)||new Set(models.map(m=>m.id)).size!==models.length||!ages.length||ages.some(a=>!Number.isInteger(a)||a<3||a>18)||new Set(ages).size!==ages.length||models.length*ages.length>80)return null;
    const ids=new Set(),combos=new Set(),cells=[];
    for(const cell of input.cells) {
      const combo=cell?.model+':'+cell?.age;
      if(!isUUID(cell?.id)||ids.has(cell.id)||combos.has(combo)||!models.some(m=>m.id===cell.model)||!ages.includes(cell.age))return null;
      if(!structuredComposition({description:input.prompt,age:cell.age,composition:input.composition,batchID:input.id}))return null;
      ids.add(cell.id);combos.add(combo);cells.push({id:cell.id,model:cell.model,age:cell.age,status:'queued',metrics:null,error:null});
    }
    const createdAt=input.imported===true&&Number.isSafeInteger(input.createdAt)&&input.createdAt>0&&input.createdAt<=Date.now()?input.createdAt:Date.now();
    return {id:input.id,prompt:input.prompt.trim(),composition:input.composition,models,ages:[...ages].sort((a,b)=>a-b),createdAt,cells};
  }
  async observe(grid,cell,job) {
    if(['completed','failed'].includes(cell.status)&&job.state==='processing')return;
    const changed=cell.status!==job.state||cell.error!==(job.message??null)||JSON.stringify(cell.metrics)!==JSON.stringify(job.metrics??null);
    cell.status=job.state;cell.metrics=job.metrics??null;cell.error=job.message??null;
    if(changed)await this.write(grid);
    if(['completed','failed'].includes(cell.status))await this.state.storage.delete('pending:'+cell.id);
  }
  async save(input) {
    const grid=this.normalize(input);if(!grid)return fail('The saved comparison is invalid.');
    if(await this.state.storage.get('retired:'+grid.id))return fail('This comparison has left the library.',410,'grid_expired');
    const existing=await this.state.storage.get('grid:'+grid.id);
    if(existing) {
      const spec=g=>JSON.stringify({prompt:g.prompt,composition:g.composition,cells:g.cells.map(c=>({id:c.id,model:c.model,age:c.age}))});
      return spec(existing)===spec(grid)?json({grid:existing}):fail('This comparison ID is already in use.',409);
    }
    for(const cell of grid.cells)if(await this.state.storage.get('image:'+cell.id))return fail('An image already belongs to another comparison.',409);
    if(input.imported===true) {
      for(const cell of grid.cells) {
        const found=await this.call('/job',{generationId:cell.id});
        if(found.status===200) {
          const composed=structuredComposition({description:grid.prompt,age:cell.age,composition:grid.composition,batchID:grid.id});
          const fingerprints=await generationFingerprints(composed.subject,cell.model,{width:1456,height:1024});
          if(!Object.values(fingerprints).includes(found.value.job.fingerprint))return fail('A saved image does not match this comparison.',409);
          cell.status=found.value.job.state;cell.metrics=found.value.job.metrics??null;cell.error=found.value.job.message??null;
        } else if(found.status!==404)return fail('Could not import the saved comparison.',503);
      }
    }
    const index=(await this.state.storage.get('index'))??[];
    grid.sequence=((await this.state.storage.get('sequence'))??0)+1;
    // Retain by creation time, including imports: an old import cannot evict a newer grid.
    const ordered=[...index,summary(grid)].sort((a,b)=>b.createdAt-a.createdAt||(b.sequence??0)-(a.sequence??0)||b.id.localeCompare(a.id));
    if(ordered.length>LIMIT&&ordered.at(-1).id===grid.id)return fail('This older comparison falls outside the newest 100 grids.',410,'grid_expired');
    const evicted=ordered.length>LIMIT?await this.state.storage.get('grid:'+ordered.at(-1).id):null;
    await this.state.storage.transaction(async storage=>{
      if(evicted) {
        await storage.put('retired:'+evicted.id,true);
        for(const cell of evicted.cells){await storage.put('image:'+cell.id,{gridId:evicted.id,retired:true});await storage.put('cleanup:'+cell.id,true);await storage.delete('pending:'+cell.id);}
        await storage.delete('grid:'+evicted.id);
      }
      for(const cell of grid.cells){await storage.put('image:'+cell.id,{gridId:grid.id});if(cell.status==='processing')await storage.put('pending:'+cell.id,grid.id);}
      await storage.put('grid:'+grid.id,grid);await storage.put('index',ordered.slice(0,LIMIT));await storage.put('sequence',grid.sequence);
    });
    if(evicted||grid.cells.some(c=>c.status==='processing'))await this.schedule();
    return json({grid},201);
  }
  async job(id) {
    const link=await this.state.storage.get('image:'+id);
    if(link?.retired)return fail('This comparison has left the library.',410,'grid_expired');
    const result=await this.call('/job',{generationId:id});
    if(result.status!==200)return json(result.value,result.status);
    if(link) {
      const update=this.serial(async()=>{
        const latest=await this.state.storage.get('image:'+id);
        if(!latest||latest.retired)return;
        const grid=await this.state.storage.get('grid:'+latest.gridId),cell=grid?.cells.find(c=>c.id===id);
        if(cell)await this.observe(grid,cell,result.value.job);
      });
      if(typeof this.state.waitUntil==='function')this.state.waitUntil(update);
      else await update;
    }
    return json(publicJob(result.value.job,result.value.access));
  }
  async start(input) {
    if(!input||!isUUID(input.id)||!isUUID(input.batchID)||typeof input.model!=='string')return fail('Invalid comparison request.');
    const prepared=await prepareGeneration({description:input.description,age:input.age,composition:input.composition,batchID:input.batchID,model:input.model,width:1456,height:1024},input.id,this.env);
    if(prepared.value?.error)return json(prepared.value,prepared.status);
    const composed=prepared.composed;
    const selected=catalog(this.env).find(m=>m.id===input.model);
    if(!composed||!selected)return fail('Shorten the prompt or check your model and age settings.');
    if(await this.state.storage.get('retired:'+input.batchID))return fail('This comparison has left the library.',410,'grid_expired');
    let grid=await this.state.storage.get('grid:'+input.batchID);
    if(!grid) {
      // Older open tabs are also saved automatically on their first request.
      const made=await this.save({id:input.batchID,prompt:composed.description,composition:input.composition,models:[selected],ages:[input.age],cells:[{id:input.id,model:input.model,age:input.age}]});
      if(made.status>=400)return made;grid=(await made.json()).grid;
    }
    if(grid.prompt!==composed.description||grid.composition!==input.composition)return fail('This comparison uses a different prompt or viewpoint.',409);
    const link=await this.state.storage.get('image:'+input.id);
    if(link&&(link.retired||link.gridId!==grid.id))return fail('This image already belongs to another comparison.',409);
    const usedCell=grid.cells.find(c=>c.id===input.id);
    if(usedCell&&(usedCell.model!==input.model||usedCell.age!==input.age))return fail('This image ID belongs to another model or age.',409);
    let cell=grid.cells.find(c=>c.model===input.model&&c.age===input.age);
    if(!cell) {
      const models=grid.models.some(m=>m.id===selected.id)?grid.models:[...grid.models,selected];
      const ages=grid.ages.includes(input.age)?grid.ages:[...grid.ages,input.age].sort((a,b)=>a-b);
      if(models.length*ages.length>80)return fail('The limit is 80 images per comparison.');
      cell={id:input.id,model:input.model,age:input.age,status:'queued',metrics:null,error:null};grid.cells.push(cell);grid.models=models;grid.ages=ages;
    } else if(cell.id!==input.id) {
      if(cell.status!=='failed')return fail('An image for this model and age is already in progress or complete.',409);
      await this.state.storage.put('image:'+cell.id,{gridId:grid.id,retired:true});await this.state.storage.put('cleanup:'+cell.id,true);
      cell.id=input.id;cell.status='queued';cell.metrics=null;cell.error=null;await this.schedule();
    }
    await this.state.storage.put('image:'+cell.id,{gridId:grid.id});await this.write(grid);
    const result=await startGeneration(prepared,{
      env:this.env,call:(path,value)=>this.call(path,value),queueImages:true,
      // Provider credentials remain in the production Account object. That
      // object validates the provider request again before making inference.
      validateProvider:false,fingerprintFormat:'hex',allowRoute:route=>route.provider!=='fal',
      rateLimit:async()=>!this.env.GENERATION_LIMITER||!(await this.env.GENERATION_LIMITER.limit({key:'shared-lab'})).success
        ? {status:429,value:{error:{code:'request_failed',message:'Please wait a minute before starting more images.'}}}:null,
      beforeReserve:async()=>{
        cell.status='processing';await this.write(grid);await this.state.storage.put('pending:'+cell.id,grid.id);await this.schedule();
      }
    });
    if(result.value?.error)return this.failed(grid,cell,result.value.error.message,result.status,result.value.error.code);
    await this.observe(grid,cell,result.job);
    return json(publicJob(result.job,result.access),!result.recovered&&cell.status==='processing'?202:200);
  }

  async failed(grid,cell,message,status,code='request_failed') {
    cell.status='failed';cell.error=message;await this.state.storage.delete('pending:'+cell.id);await this.write(grid);return fail(message,status,code);
  }
  async handle(request) {
    const path=new URL(request.url).pathname;
    if(path==='/list')return json({grids:(await this.state.storage.get('index'))??[],limit:LIMIT});
    const input=await request.json();
    if(path==='/save')return this.save(input);
    if(path==='/start')return this.start(input);
    if(!isUUID(input?.id))return fail('Invalid comparison ID.');
    if(path==='/get') {const grid=await this.state.storage.get('grid:'+input.id);return grid?json({grid}):fail('This comparison is no longer in the library.',404);}
    if(path==='/job')return this.job(input.id);
    if(path==='/lookup') {const link=await this.state.storage.get('image:'+input.id);return link?.retired?fail('This comparison has left the library.',410,'grid_expired'):json({found:!!link});}
    return fail('Not found.',404);
  }
  alarm() { return this.serial(async()=>{
    const pending=await this.state.storage.list({prefix:'pending:',limit:24});
    for(const [key,gridId] of pending) {
      const id=key.slice('pending:'.length),grid=await this.state.storage.get('grid:'+gridId),cell=grid?.cells.find(c=>c.id===id);
      if(!cell){await this.state.storage.delete(key);continue;}
      try {const result=await this.call('/job',{generationId:id});if(result.status===200)await this.observe(grid,cell,result.value.job);else if(result.status===404){cell.status='queued';await this.write(grid);await this.state.storage.delete(key);}}catch{/* Retry on the next alarm. */}
    }
    const cleanup=await this.state.storage.list({prefix:'cleanup:',limit:80});
    for(const [key] of cleanup) {
      const id=key.slice('cleanup:'.length);
      try {
        // Only this shared lab account's image prefix is ever deleted.
        const result=await this.call('/job',{generationId:id});
        if(result.status===404||(result.status===200&&['completed','failed'].includes(result.value.job.state))){
          await this.env.GENERATIONS.delete(this.env.LAB_ACCOUNT_ID+'/'+id+'.png');
          await this.state.storage.delete(key);
        }
      }catch{/* Durable tombstone and cleanup entry survive for retry. */}
    }
    const more=(await this.state.storage.list({prefix:'pending:',limit:1})).size||(await this.state.storage.list({prefix:'cleanup:',limit:1})).size;
    if(more)await this.state.storage.setAlarm(Date.now()+10000);
  }); }
}
