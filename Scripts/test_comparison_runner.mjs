import assert from 'node:assert/strict';
import {ComparisonImageRunner} from '../workers/coloring-sheets-api/src/comparison-image-runner.mjs';
import {structuredComposition,MAX_COMPOSED_SUBJECT_LENGTH} from '../workers/coloring-sheets-api/src/composition.mjs';
class Storage {
  constructor(){this.values=new Map();this.alarm=null;}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async transaction(callback){return callback(this);}
  async setAlarm(value){this.alarm=value;}
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const accountId=crypto.randomUUID(),id=crypto.randomUUID(),images=new Map(),reports=[],jobs=new Map();let failReport=false;
const env={COMPARISON_ACCOUNT_ID:accountId,OPENAI_API_KEY:'PRIVATE-API-KEY-SENTINEL',GENERATIONS:{put:async(key,value)=>images.set(key,value),get:async key=>images.get(key),delete:async key=>images.delete(key)},ACCOUNTS:{idFromName:value=>{assert.equal(value,accountId);return value;},get:()=>({fetch:async(url,options)=>{
  const input=JSON.parse(options.body);
  if(new URL(url).pathname==='/complete'){
    if(failReport)throw Error('Lost completion response');
    reports.push(input);jobs.set(input.generationId,input.result);return Response.json({access:{}});
  }
  return Response.json({job:jobs.get(input.generationId)??{state:'processing'}});
}})}};
const task={id,accountId,fingerprint:'synthetic-fingerprint',createdAt:Date.now()-100,route:{provider:'openai',model:'gpt-image-2.5-flare'},subject:'A synthetic friendly flower',size:{width:1456,height:1024},publicModel:'gpt-image-2.5-flare'};
const request=(input=task)=>new Request('https://runner/start',{method:'POST',body:JSON.stringify(input)});
const originalFetch=globalThis.fetch;let calls=0,release;
const originalInfo=console.info,logs=[];console.info=value=>logs.push(JSON.parse(value));
globalThis.fetch=async()=>{calls++;if(release)await new Promise(resolve=>release=resolve);return Response.json({data:[{b64_json:png}],usage:{input_tokens:1,output_tokens:2}});};
try{
  const storage=new Storage();let runner=new ComparisonImageRunner({storage},env);
  assert.equal((await runner.fetch(request({...task,accountId:crypto.randomUUID()}))).status,400);
  assert.equal((await runner.fetch(request())).status,202);assert.equal(calls,0,'HTTP handoff only schedules an alarm.');
  assert.equal((await runner.fetch(request())).status,202);
  assert.equal((await runner.fetch(request({...task,fingerprint:'other'}))).status,409);
  await runner.alarm();assert.equal(calls,1);assert.equal(reports.length,1);assert.equal(reports[0].result.state,'completed');
  assert.ok(images.has(accountId+'/'+id+'.png'));assert.ok(reports[0].result.metrics.inferenceMs>=0);assert.ok(reports[0].result.metrics.queueMs>=0);
  assert.ok(!JSON.stringify(await storage.get('task')).includes(task.subject));assert.ok(!JSON.stringify(await storage.get('task')).includes('synthetic"'));
  runner=new ComparisonImageRunner({storage},env);await runner.fetch(request());await runner.alarm();assert.equal(calls,1,'Restart and duplicate handoff never infer twice.');
  // A restart after an ambiguous provider submission reports failure, never resubmits.
  const interrupted=new Storage();await interrupted.put('task',{...task,id:crypto.randomUUID(),stage:'submitting'});
  await new ComparisonImageRunner({storage:interrupted},env).alarm();assert.equal(calls,1);assert.equal(reports.at(-1).result.state,'failed');
  // Recovery after R2 committed can report success without another provider call.
  const saved=new Storage(),savedId=crypto.randomUUID();images.set(accountId+'/'+savedId+'.png',new Uint8Array([137]));
  await saved.put('task',{...task,id:savedId,stage:'saving',metrics:{elapsedMs:20}});
  await new ComparisonImageRunner({storage:saved},env).alarm();assert.equal(calls,1);assert.equal(reports.at(-1).result.state,'completed');
  // A failed completion RPC retries only the result report.
  const reporting=new Storage(),reportId=crypto.randomUUID();await reporting.put('task',{...task,id:reportId,stage:'reporting',result:{state:'failed',errorCode:'synthetic'}});
  failReport=true;await assert.rejects(new ComparisonImageRunner({storage:reporting},env).alarm());failReport=false;
  await new ComparisonImageRunner({storage:reporting},env).alarm();assert.equal(calls,1);assert.equal((await reporting.get('task')).stage,'done');
  // Each image has its own executor; one slow runner does not block another.
  let slowRelease;globalThis.fetch=async()=>{calls++;if(calls===2)await new Promise(resolve=>slowRelease=resolve);return Response.json({data:[{b64_json:png}]});};
  const slow=new ComparisonImageRunner({storage:new Storage()},env),fast=new ComparisonImageRunner({storage:new Storage()},env);
  const slowId=crypto.randomUUID(),fastId=crypto.randomUUID();await slow.fetch(request({...task,id:slowId}));await fast.fetch(request({...task,id:fastId}));
  const slowWork=slow.alarm();await new Promise(resolve=>setImmediate(resolve));
  const duplicateWatchdog=slow.alarm();await fast.alarm();assert.equal(calls,3);assert.ok(jobs.has(fastId));assert.ok(!jobs.has(slowId));
  slowRelease();await Promise.all([slowWork,duplicateWatchdog]);assert.equal(calls,3);
  // A full-length app description must also fit the internal handoff after
  // trusted guidance is added. Keep an explicit bound on internal tasks.
  const composed=structuredComposition({description:'x'.repeat(500),age:13,composition:'close',batchID:crypto.randomUUID()});
  assert.ok(composed.subject.length>500);
  const longId=crypto.randomUUID(),longRunner=new ComparisonImageRunner({storage:new Storage()},env);
  assert.equal((await longRunner.fetch(request({...task,id:longId,subject:'x'.repeat(MAX_COMPOSED_SUBJECT_LENGTH+1)}))).status,400);
  assert.equal((await longRunner.fetch(request({...task,id:longId,subject:composed.subject}))).status,202);
  await longRunner.alarm();assert.equal(calls,4);assert.equal(jobs.get(longId).state,'completed');
  // Provider failures retain enough safe protocol metadata to investigate a
  // single image without saving provider text, prompts, keys, or raw headers.
  const failureId=crypto.randomUUID(),gatewayID=crypto.randomUUID();
  globalThis.fetch=async()=>{calls++;return Response.json({errors:[{code:3040,message:'PRIVATE-PROVIDER-TEXT '+task.subject},{code:'PRIVATE-CODE-TEXT'},{code:'rate_limit_exceeded'}]},
    {status:429,headers:{'x-request-id':'req_12345678','cf-aig-log-id':gatewayID,'cf-ray':'0123456789abcdef-LHR','retry-after':'30','x-secret':'PRIVATE-HEADER'}});};
  const failureRunner=new ComparisonImageRunner({storage:new Storage()},env);
  await failureRunner.fetch(request({...task,id:failureId}));await failureRunner.alarm();
  const failed=jobs.get(failureId);assert.equal(failed.state,'failed');assert.equal(failed.errorCode,'provider_rate_limited');
  assert.equal(failed.metrics.httpStatus,429);assert.equal(failed.metrics.failureStage,'submitting');assert.ok(failed.metrics.inferenceMs>=0);
  assert.deepEqual(failed.metrics.upstreamErrorCodes,['3040','rate_limit_exceeded']);assert.equal(failed.metrics.retryAfterSeconds,30);
  assert.equal(failed.metrics.gatewayRequestID,gatewayID);assert.equal(failed.metrics.providerRequestID,'req_12345678');assert.equal(failed.metrics.cfRay,'0123456789abcdef-LHR');
  assert.ok(logs.some(log=>log.generationID===failureId&&log.outcome==='failed'&&log.httpStatus===429));
  assert.ok(logs.some(log=>log.outcome==='persistence_retry'));
  const diagnosticJSON=JSON.stringify({logs,failed});
  for(const privateText of [task.subject,'PRIVATE-PROVIDER-TEXT','PRIVATE-CODE-TEXT','PRIVATE-HEADER',env.OPENAI_API_KEY,png])assert.ok(!diagnosticJSON.includes(privateText),'Diagnostics must omit '+privateText);
  // Even syntactically plausible unknown request metadata must not leak.
  globalThis.fetch=async()=>Response.json({errors:[{code:'arbitrary_user_text',message:'PRIVATE'}]},
    {status:400,headers:{'x-request-id':'private-user-description','cf-aig-log-id':'PRIVATE','cf-ray':'PRIVATE','retry-after':'PRIVATE'}});
  const rejectedId=crypto.randomUUID(),rejectedRunner=new ComparisonImageRunner({storage:new Storage()},env);
  await rejectedRunner.fetch(request({...task,id:rejectedId}));await rejectedRunner.alarm();
  const diagnostics=jobs.get(rejectedId).metrics;assert.equal(diagnostics.httpStatus,400);assert.deepEqual(diagnostics.upstreamErrorCodes,[]);
  for(const field of ['providerRequestID','gatewayRequestID','cfRay','retryAfterSeconds'])assert.equal(diagnostics[field],undefined);
  console.log('PASS: independent image execution, durable handoff, one inference per ID, watchdog deduplication, ambiguous-submission safety, saved-image recovery, completion retries, and prompt removal; no network.');
}finally{globalThis.fetch=originalFetch;console.info=originalInfo;}
