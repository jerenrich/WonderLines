import assert from 'node:assert/strict';
import {ComparisonLibrary} from '../src/library.mjs';
import {MemoryStorage} from './storage.mjs';
const storage=new MemoryStorage(),jobs=new Map(),deleted=[];
const accountId='f66c3047-7ae6-4a1d-9144-7514e7a44961';
let reservations=0;
const env={LAB_ACCOUNT_ID:accountId,GENERATION_LIMITER:{limit:async()=>({success:true})},GENERATIONS:{delete:async key=>deleted.push(key)},ACCOUNTS:{idFromName:id=>{assert.equal(id,accountId);return id;},get:()=>({fetch:async(url,options)=>{
  const path=new URL(url).pathname,input=JSON.parse(options.body);
  if(path==='/job')return Response.json(jobs.has(input.generationId)?{job:jobs.get(input.generationId),access:{freeGenerationsRemaining:99}}:{error:{}},{status:jobs.has(input.generationId)?200:404});
  if(path==='/moderate-batch')return Response.json({approved:true});
  if(path==='/reserve'){reservations++;const job={id:input.generationId,state:'processing',fingerprint:input.fingerprint,createdAt:Date.now()};jobs.set(job.id,job);return Response.json({job,access:{}},{status:201});}
  throw Error('Unexpected '+path);
}})}};
let library=new ComparisonLibrary({storage},env);
const call=(path,input={})=>library.fetch(new Request('https://library'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}));
const run=(createdAt=Date.now()-100000)=>({id:crypto.randomUUID(),prompt:'A friendly flower',composition:'front',models:[{id:'flux-2-klein-4b'}],ages:[4],createdAt,imported:true,cells:[{id:crypto.randomUUID(),model:'flux-2-klein-4b',age:4}]});
const first=run(),second=run(first.createdAt+1);
assert.equal((await call('/save',{...first,cells:Array.from({length:81},()=>({...first.cells[0],id:crypto.randomUUID()}))})).status,400);
assert.equal((await call('/save',{...first,cells:[{...first.cells[0],model:'arbitrary-model'}]})).status,400);
assert.equal((await call('/save',first)).status,201);
assert.equal((await call('/save',first)).status,200);
assert.equal((await call('/save',{...first,prompt:'Changed'})).status,409);
assert.equal((await call('/save',{...second,cells:first.cells})).status,409);
const input={id:first.cells[0].id,batchID:first.id,description:first.prompt,age:4,composition:'front',model:'flux-2-klein-4b'};
assert.equal((await call('/start',input)).status,202);assert.equal(reservations,1);
assert.equal((await call('/start',input)).status,200);assert.equal(reservations,1);
// The pending queue survives object restarts and updates the saved grid without a browser.
library=new ComparisonLibrary({storage},env);
jobs.get(input.id).state='completed';jobs.get(input.id).metrics={elapsedMs:2000,estimatedTotalUsd:0.003};
await library.alarm();
let saved=(await (await call('/get',{id:first.id})).json()).grid;
assert.equal(saved.cells[0].status,'completed');assert.equal(saved.cells[0].metrics.estimatedTotalUsd,0.003);
assert.equal((await storage.list({prefix:'pending:'})).size,0);
assert.equal((await call('/save',second)).status,201);
// Keep one evicted image in flight to verify cleanup waits for the eventual write.
const inFlight={...second.cells[0],state:'processing',id:second.cells[0].id};jobs.set(inFlight.id,inFlight);
for(let i=2;i<100;i++)assert.equal((await call('/save',run(first.createdAt+i))).status,201);
assert.equal((await (await call('/list')).json()).grids.length,100);
const newest=run(first.createdAt+100);
assert.equal((await call('/save',newest)).status,201);
let list=await (await call('/list')).json();
assert.equal(list.grids.length,100);assert.equal(list.grids[0].id,newest.id);assert.ok(!list.grids.some(g=>g.id===first.id));
assert.equal((await call('/get',{id:first.id})).status,404);
assert.equal((await call('/lookup',{id:input.id})).status,410);
assert.equal((await call('/save',first)).status,410);
assert.equal((await call('/start',input)).status,410);assert.equal(reservations,1);
await library.alarm();assert.ok(deleted.includes(accountId+'/'+input.id+'.png'));
assert.equal((await call('/save',run(first.createdAt+101))).status,201);
await library.alarm();assert.ok(!deleted.includes(accountId+'/'+inFlight.id+'.png'));
inFlight.state='completed';jobs.set(inFlight.id,inFlight);await library.alarm();assert.ok(deleted.includes(accountId+'/'+inFlight.id+'.png'));
assert.ok(deleted.every(key=>key.startsWith(accountId+'/')));
const tooOld=run(first.createdAt-1);assert.equal((await call('/save',tooOld)).status,410);
assert.equal((await (await call('/list')).json()).grids.length,100);
// Concurrent saves are serialized and never exceed the retained-grid limit.
const concurrent=Array.from({length:6},(_,i)=>run(first.createdAt+200+i));
const responses=await Promise.all(concurrent.map(grid=>call('/save',grid)));assert.ok(responses.every(r=>r.status===201));
list=await (await call('/list')).json();assert.equal(list.grids.length,100);assert.equal(new Set(list.grids.map(g=>g.id)).size,100);
// A failed R2 deletion keeps its durable cleanup marker for the next alarm.
const cleanupKeys=await storage.list({prefix:'cleanup:'});assert.ok(cleanupKeys.size>0);
const failureKey=cleanupKeys.keys().next().value;env.GENERATIONS.delete=async()=>{throw Error('R2 unavailable');};
await library.alarm();assert.equal(await storage.get(failureKey),true);
env.GENERATIONS.delete=async key=>deleted.push(key);await library.alarm();assert.equal(await storage.get(failureKey),undefined);
console.log('PASS: persistent library, input validation, idempotent saves, server-owned status/costs, restart reconciliation, 100-grid retention, chronological import, concurrent eviction, image cleanup, cleanup retries, in-flight eviction and tombstones preventing regeneration');
// Read-only endpoints remain responsive while a generation mutation is waiting.
let releaseMutation;const held=library.serial(()=>new Promise(resolve=>{releaseMutation=resolve;}));
await new Promise(resolve=>setImmediate(resolve));
let readFinished=false;const read=call('/list').then(result=>{readFinished=true;return result;});
await new Promise(resolve=>setImmediate(resolve));assert.equal(readFinished,true,'Listing must not wait for the generation lock.');
assert.equal((await read).status,200);releaseMutation();await held;
// Repeated unchanged status polls must not rewrite an entire grid/index.
const latest=(await (await call('/list')).json()).grids[0];const latestGrid=(await (await call('/get',{id:latest.id})).json()).grid;
const cell=latestGrid.cells[0];jobs.set(cell.id,{id:cell.id,state:'processing',metrics:null});
await call('/job',{id:cell.id});let writes=0;const originalPut=storage.put.bind(storage);
storage.put=async(key,value)=>{if(key==='grid:'+latest.id)writes++;return originalPut(key,value);};
await call('/job',{id:cell.id});await call('/job',{id:cell.id});assert.equal(writes,0);storage.put=originalPut;
console.log('PASS: library reads bypass generation locking and unchanged status polls avoid grid/index rewrites.');
