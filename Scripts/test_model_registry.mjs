import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseModelRegistry, loadModelCatalog, MODEL_REGISTRY_KEY} from '../workers/coloring-sheets-api/src/model-registry.mjs';
import {prepareGeneration, startGeneration, generationFingerprints} from '../workers/coloring-sheets-api/src/generation-start.mjs';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';

const seed = JSON.parse(await readFile(new URL('../workers/coloring-sheets-api/model-registry.initial.json', import.meta.url)));
let document = structuredClone(seed), reads = 0, broken = false;
const kv = {async get(key, options) {
  assert.equal(key, MODEL_REGISTRY_KEY); assert.deepEqual(options, {type:'text', cacheTtl:60}); reads++;
  if (broken) throw new Error('Synthetic read outage');
  return document === null ? null : JSON.stringify(document);
}};
const env = {MODEL_REGISTRY: kv, IMAGE_MODEL_ROUTES:'invalid legacy config', IMAGE_DEFAULT_MODEL:'ignored'};
assert.equal(parseModelRegistry(seed).models.length, 6);
assert.equal(Object.keys(parseModelRegistry(seed).routes).length, 13);
assert.equal((await loadModelCatalog(env)).defaultModel, 'gpt-image-2.5-sunburst');
assert.ok(!(await loadModelCatalog(env)).models.some(model => model.id === 'coloringbook-redmond-v2'));
assert.ok((await loadModelCatalog(env)).routes['coloringbook-redmond-v2'], 'Hidden models remain valid for explicit requests.');

const added = {id:'new-image-choice', provider:'openai', model:'compatible-image-model', enabled:true, visible:true,
  label:'New choice', detail:'A server-defined model.', price:null};
document.models.unshift(added); document.defaultModel=added.id; document.revision='added';
let catalogue = await loadModelCatalog(env);
assert.equal(catalogue.defaultModel, added.id); assert.equal(catalogue.models[0].label, 'New choice');
assert.equal(catalogue.models[0].price, null);
document.providers.openai.enabled=false;
catalogue=await loadModelCatalog(env);
assert.ok(!Object.values(catalogue.routes).some(route=>route.provider==='openai'));
assert.equal(catalogue.defaultModel, 'z-image-turbo');
for(const provider of Object.values(document.providers)) provider.enabled=false;
assert.deepEqual((await loadModelCatalog(env)).models, []);
assert.equal((await loadModelCatalog(env)).defaultModel, null);

const invalid = [
  null, {}, {...seed,schemaVersion:2}, {...seed,defaultModel:'absent'}, {...seed,revision:''},
  {...seed,providers:{openai:{enabled:'false'}}}, {...seed,models:[seed.models[0], seed.models[0]]},
  {...seed,models:[{...added,provider:'unsupported'}]}, {...seed,models:[{...added,id:'../image'}]},
  {...seed,defaultModel:added.id,models:[{...added,model:'../image'}]},
  {...seed,models:[{...added,price:{usd:-1,evidence:'Estimate',explanation:'Invalid'}}]},
  {...seed,models:[{...added,apiKey:'must not be accepted'}]},
  {...seed,models:[{...added,enabled:'false'}]}, {...seed,models:[{...added,price:undefined}]}
];
for(const value of invalid) assert.throws(()=>parseModelRegistry(value));
document=null; await assert.rejects(loadModelCatalog(env));
broken=true; await assert.rejects(loadModelCatalog(env)); broken=false;
document=structuredClone(seed);
assert.ok((await loadModelCatalog({})).models.length, 'Unbound migration mode still supports existing deployments.');

let calls=[], moderation=0;
const call=async(path,input)=>{
  calls.push({path,input});
  if(path==='/job')return {status:404,value:{}};
  if(path==='/moderate-batch'){moderation++;return {status:200,value:{}};}
  if(path==='/reserve')return {status:201,value:{job:{id:input.generationId,state:'processing'},access:{}}};
  throw new Error(path);
};
const input={description:'A friendly flower',age:6,composition:'front',batchID:crypto.randomUUID(),model:'gpt-image-2.5-sunburst',width:1456,height:1024};
const prepare=values=>prepareGeneration({...input,...values},crypto.randomUUID(),env);
const start=async values=>startGeneration(await prepare(values),{env,call,queueImages:true,validateProvider:false});
let result=await start({}); assert.equal(result.status,201);
const pinned=calls.find(entry=>entry.path==='/reserve').input;
assert.equal(pinned.imageTask.route.provider,'openai');
assert.equal(pinned.publicModel,input.model);
assert.deepEqual(pinned.modelRoute,pinned.imageTask.route);

document.models.find(model=>model.id===input.model).enabled=false;
calls=[]; moderation=0; result=await start({});
assert.equal(result.status,409); assert.equal(result.value.error.code,'model_unavailable');
assert.deepEqual(calls.map(entry=>entry.path),['/job']); assert.equal(moderation,0);
const existing={...pinned,state:'processing'};
result=await startGeneration(await prepare({}),{env:{MODEL_REGISTRY:{get:async()=>{throw new Error('must not read on recovery');}}},
  call:async()=>({status:200,value:{job:existing,access:{}}})});
assert.equal(result.recovered,true,'Existing jobs recover without KV, moderation or provider configuration.');

document.models.unshift(added); document.defaultModel=added.id;
calls=[]; const omitted=await prepare({model:undefined});
result=await startGeneration(omitted,{env,call,queueImages:true,validateProvider:false});
assert.equal(result.status,201); assert.equal(omitted.model,added.id);
const reserved=calls.find(entry=>entry.path==='/reserve').input;
const recovered=await startGeneration(await prepare({model:undefined}),{env:{MODEL_REGISTRY:{get:async()=>{throw new Error('must not read');}}},
  call:async()=>({status:200,value:{job:{...reserved,state:'processing'},access:{}}})});
assert.equal(recovered.recovered,true,'Omitted-model requests keep their original default on idempotent recovery.');
assert.notEqual(reserved.fingerprint,(await generationFingerprints(input.description,input.model,{width:1456,height:1024})).base64url);

// Exercise authenticated HTTP discovery and the final Account budget boundary.
class Storage {
  values=new Map();
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async delete(key){this.values.delete(key);}
  async setAlarm(time){this.alarm=time;}
  async transaction(callback){return callback(this);}
  async list({prefix,limit=Infinity}){return new Map([...this.values].filter(([key])=>key.startsWith(prefix)).slice(0,limit));}
}
const httpEnv={MODEL_REGISTRY:kv,ACCOUNT_TOKEN_SECRET:'synthetic-only-secret',FREE_DAILY_ALLOWANCE:'10',GLOBAL_DAILY_GENERATION_LIMIT:'100',REGISTRATION_LIMITER:{limit:async()=>({success:true})},OPENAI_API_KEY:'synthetic'};
const accounts=new Map();
httpEnv.ACCOUNTS={idFromName:id=>id,get(id){
  if(!accounts.has(id))accounts.set(id,new Account({storage:new Storage()},httpEnv));
  return {fetch:(url,options)=>accounts.get(id).fetch(new Request(url,options))};
}};
const budgets=new Map();
httpEnv.BUDGET={idFromName:id=>id,get(id){
  if(!budgets.has(id))budgets.set(id,new Budget({storage:new Storage()},httpEnv));
  return {fetch:(url,options)=>budgets.get(id).fetch(new Request(url,options))};
}};
let response=await worker.fetch(new Request('https://example.test/v1/models'),httpEnv);
assert.equal(response.status,401);
response=await worker.fetch(new Request('https://example.test/v1/installations',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:'{}'}),httpEnv);
assert.equal(response.status,201);const identity=await response.json();
const getModels=()=>worker.fetch(new Request('https://example.test/v1/models',{headers:{Authorization:'Bearer '+identity.accessToken}}),httpEnv);
response=await getModels();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
const publicCatalogue=await response.json();assert.equal(publicCatalogue.defaultModel,added.id);
assert.equal(publicCatalogue.models[0].label,'New choice');
assert.ok(!JSON.stringify(publicCatalogue).includes('synthetic'));
const account=accounts.get(identity.accountId),accessBefore=await account.access(),budgetCount=budgets.size;
const invokeReserve=value=>account.fetch(new Request('https://account/reserve',{method:'POST',body:JSON.stringify(value)}));
response=await invokeReserve({generationId:crypto.randomUUID(),publicModel:input.model,fingerprint:'disabled',modelRoute:{provider:'openai',model:input.model}});
assert.equal(response.status,409);assert.deepEqual(await account.access(),accessBefore);assert.equal(budgets.size,budgetCount);
response=await invokeReserve({generationId:crypto.randomUUID(),publicModel:added.id,fingerprint:'remapped',modelRoute:{provider:'fal',model:'z-image-turbo'}});
assert.equal(response.status,409);assert.deepEqual(await account.access(),accessBefore);
const queuedID=crypto.randomUUID();
response=await invokeReserve({generationId:queuedID,publicModel:added.id,fingerprint:'queued',modelRoute:{provider:'openai',model:added.model},imageTask:{route:{provider:'openai',model:added.model},publicModel:added.id,subject:'flower',size:{width:1456,height:1024}}});
assert.equal(response.status,201);
document.models[0].enabled=false;
response=await invokeReserve({generationId:queuedID,publicModel:added.id,fingerprint:'queued'});assert.equal(response.status,200);
assert.equal((await response.json()).job.imageTask.route.model,added.model,'Submitted routes remain pinned.');
for(const provider of Object.values(document.providers))provider.enabled=false;
response=await getModels();assert.equal(response.status,200);assert.deepEqual((await response.json()).models,[]);
document=null;response=await getModels();assert.equal(response.status,503);
broken=true;response=await getModels();assert.equal(response.status,503);
assert.ok(reads>10);
console.log('PASS: KV catalogue validation, live additions, provider/model switches, visibility, defaults, fail-closed outages, authenticated discovery, no-spend rejection, route pinning and recovery; no network or paid inference.');
