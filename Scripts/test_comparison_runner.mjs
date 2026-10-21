import assert from 'node:assert/strict';
import {ComparisonImageRunner} from '../workers/coloring-sheets-api/src/comparison-image-runner.mjs';
class Storage {
  constructor(){this.values=new Map();this.alarm=null;}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async transaction(callback){return callback(this);}
  async setAlarm(value){this.alarm=value;}
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const accountId=crypto.randomUUID(),id=crypto.randomUUID(),images=new Map(),reports=[],jobs=new Map();let failReport=false;
const env={COMPARISON_ACCOUNT_ID:accountId,OPENAI_API_KEY:'synthetic',GENERATIONS:{put:async(key,value)=>images.set(key,value),get:async key=>images.get(key),delete:async key=>images.delete(key)},ACCOUNTS:{idFromName:value=>{assert.equal(value,accountId);return value;},get:()=>({fetch:async(url,options)=>{
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
  console.log('PASS: independent image execution, durable handoff, one inference per ID, watchdog deduplication, ambiguous-submission safety, saved-image recovery, completion retries, and prompt removal; no network.');
}finally{globalThis.fetch=originalFetch;}
