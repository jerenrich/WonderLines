import assert from 'node:assert/strict';
import {ComparisonLibrary, IMAGE_LIMIT} from '../src/library.mjs';
import {catalog} from '../src/catalog.mjs';
import {MemoryStorage} from './storage.mjs';
const storage=new MemoryStorage(),jobs=new Map(),deleted=[];
const accountId='f66c3047-7ae6-4a1d-9144-7514e7a44961';
let reservations=0;
const env={LAB_ACCOUNT_ID:accountId,GENERATION_LIMITER:{limit:async()=>({success:true})},GENERATIONS:{delete:async key=>deleted.push(key)},ACCOUNTS:{idFromName:id=>{assert.equal(id,accountId);return id;},get:()=>({fetch:async(url,options)=>{
  const path=new URL(url).pathname,input=JSON.parse(options.body);
  if(path==='/job')return Response.json(jobs.has(input.generationId)?{job:jobs.get(input.generationId),access:{freeGenerationsRemaining:99}}:{error:{}},{status:jobs.has(input.generationId)?200:404});
  if(path==='/generation-gate')return Response.json({allowed:true});
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
const manyRun=(createdAt,count=80)=>{
  const grid=run(createdAt),models=['flux-2-klein-4b',...catalog(env).map(m=>m.id).filter(id=>id!=='flux-2-klein-4b')].slice(0,Math.ceil(count/16));
  const ages=[4,...Array.from({length:16},(_,i)=>i+3).filter(age=>age!==4)].slice(0,Math.min(count,16));
  grid.models=models.map(id=>({id}));grid.ages=ages;grid.cells=[];
  for(const model of models)for(const age of ages)if(grid.cells.length<count)grid.cells.push({id:crypto.randomUUID(),model,age});
  return grid;
};
for(let i=2;i<33;i++)assert.equal((await call('/save',manyRun(first.createdAt+i))).status,201);
assert.equal((await call('/save',manyRun(first.createdAt+33,18))).status,201);
assert.equal((await (await call('/list')).json()).imageCount,IMAGE_LIMIT);
const newest=run(first.createdAt+100);
assert.equal((await call('/save',newest)).status,201);
let list=await (await call('/list')).json();
assert.ok(list.imageCount<=IMAGE_LIMIT);assert.equal(list.grids[0].id,newest.id);assert.ok(!list.grids.some(g=>g.id===first.id));
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
assert.ok((await (await call('/list')).json()).imageCount<=IMAGE_LIMIT);
// Concurrent saves are serialized and never exceed the retained-grid limit.
const concurrent=Array.from({length:6},(_,i)=>run(first.createdAt+200+i));
const responses=await Promise.all(concurrent.map(grid=>call('/save',grid)));assert.ok(responses.every(r=>r.status===201));
list=await (await call('/list')).json();assert.ok(list.imageCount<=IMAGE_LIMIT);assert.equal(new Set(list.grids.map(g=>g.id)).size,list.grids.length);
// A failed R2 deletion keeps its durable cleanup marker for the next alarm.
const cleanupKeys=await storage.list({prefix:'cleanup:'});assert.ok(cleanupKeys.size>0);
const failureKey=cleanupKeys.keys().next().value;env.GENERATIONS.delete=async()=>{throw Error('R2 unavailable');};
await library.alarm();assert.equal(await storage.get(failureKey),true);
env.GENERATIONS.delete=async key=>deleted.push(key);await library.alarm();assert.equal(await storage.get(failureKey),undefined);
console.log('PASS: persistent library, input validation, idempotent saves, server-owned status/costs, restart reconciliation, 2,500-image retention, chronological import, concurrent eviction, image cleanup, cleanup retries, in-flight eviction and tombstones preventing regeneration');
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
// Retrying replaces only the failed slot within the same saved comparison.
// The old ID becomes inaccessible, siblings survive, and a lost response can
// recover the new reservation without spending twice.
const retryGrid=run(Date.now()-1000);retryGrid.ages=[4,7];retryGrid.cells.push({...retryGrid.cells[0],id:crypto.randomUUID(),age:7});
assert.equal((await call('/save',retryGrid)).status,201);
const startCell=cell=>({id:cell.id,batchID:retryGrid.id,description:retryGrid.prompt,age:cell.age,composition:retryGrid.composition,model:cell.model});
for(const cell of retryGrid.cells)assert.equal((await call('/start',startCell(cell))).status,202);
const [failedCell,sibling]=retryGrid.cells;
Object.assign(jobs.get(failedCell.id),{state:'failed',errorCode:'provider_unavailable',message:'Temporarily unavailable',metrics:{httpStatus:500,inferenceMs:100}});
Object.assign(jobs.get(sibling.id),{state:'completed',metrics:{estimatedTotalUsd:0.003}});
await library.alarm();
saved=(await (await call('/get',{id:retryGrid.id})).json()).grid;
assert.equal(saved.cells[0].errorCode,'provider_unavailable');assert.equal(saved.cells[0].metrics.httpStatus,500);
const retryInput={...startCell(failedCell),id:crypto.randomUUID()},beforeRetry=reservations;
assert.equal((await call('/start',retryInput)).status,202);assert.equal(reservations,beforeRetry+1);
assert.equal((await call('/start',retryInput)).status,200);assert.equal(reservations,beforeRetry+1);
saved=(await (await call('/get',{id:retryGrid.id})).json()).grid;
assert.equal(saved.cells[0].id,retryInput.id);assert.equal(saved.cells[0].status,'processing');assert.equal(saved.cells[0].errorCode,null);
assert.equal(saved.cells[1].id,sibling.id);assert.equal(saved.cells[1].status,'completed');assert.equal(saved.cells[1].metrics.estimatedTotalUsd,0.003);
assert.equal((await call('/job',{id:failedCell.id})).status,410);
assert.equal((await call('/start',{...retryInput,id:crypto.randomUUID()})).status,409);
assert.equal((await call('/start',{...startCell(sibling),id:crypto.randomUUID()})).status,409);assert.equal(reservations,beforeRetry+1);
console.log('PASS: retries preserve successful siblings, replace only failed slots, retire old IDs, clear errors, persist diagnostics and recover reservations idempotently.');

// Count image slots of every status, evict whole oldest grids, and never let an
// old import evict newer work. One new grid can require several retirements.
const capacityStorage=new MemoryStorage();
let capacityLibrary=new ComparisonLibrary({storage:capacityStorage},env);
const capacityCall=(path,input={})=>capacityLibrary.fetch(new Request('https://library'+path,{method:'POST',body:JSON.stringify(input)}));
const capacityBase=Date.now()-1000000,capacityGrids=[];
for(const [i,count] of [10,15,...Array(30).fill(80),75].entries()){
  const grid=manyRun(capacityBase+i,count);capacityGrids.push(grid);
  assert.equal((await capacityCall('/save',grid)).status,201);
}
assert.equal((await (await capacityCall('/list')).json()).imageCount,2500);
const incoming=manyRun(capacityBase+100,80);
assert.equal((await capacityCall('/save',incoming)).status,201);
const capacityList=await (await capacityCall('/list')).json();assert.equal(capacityList.imageCount,2475);assert.equal(capacityList.imageLimit,2500);
for(const grid of capacityGrids.slice(0,3)){
  assert.equal((await capacityCall('/get',{id:grid.id})).status,404);
  for(const cell of grid.cells)assert.equal((await capacityCall('/lookup',{id:cell.id})).status,410);
}
const beforeImport=await capacityStorage.get('index');
assert.equal((await capacityCall('/save',manyRun(capacityBase-1,80))).status,410);
assert.deepEqual(await capacityStorage.get('index'),beforeImport);
capacityLibrary=new ComparisonLibrary({storage:capacityStorage},env);
assert.equal((await (await capacityCall('/list')).json()).imageCount,2475);
assert.equal((await capacityCall('/save',capacityGrids[0])).status,410);

// Upgrade a pre-existing 100-grid library on the first read after deployment.
const legacyStorage=new MemoryStorage(),legacyGrids=Array.from({length:100},(_,i)=>manyRun(capacityBase+i,80));
for(const [i,grid] of legacyGrids.entries()){
  await legacyStorage.put('grid:'+grid.id,grid);
  for(const cell of grid.cells)await legacyStorage.put('image:'+cell.id,{gridId:grid.id});
}
await legacyStorage.put('index',legacyGrids.map(grid=>({id:grid.id,createdAt:grid.createdAt,count:grid.cells.length})));
const legacyLibrary=new ComparisonLibrary({storage:legacyStorage},env);
const migrated=await (await legacyLibrary.fetch(new Request('https://library/list'))).json();
assert.equal(migrated.imageCount,2480);assert.equal(migrated.grids.length,31);
assert.equal(migrated.grids[0].id,legacyGrids.at(-1).id);
assert.equal(await legacyStorage.get('retired:'+legacyGrids[0].id),true);
assert.ok(await legacyStorage.getAlarm());
assert.equal((await legacyStorage.list({prefix:'cleanup:'})).size,69*80);

// The existing 100-grid safety limit also remains in force for small grids.
const smallStorage=new MemoryStorage(),smallLibrary=new ComparisonLibrary({storage:smallStorage},env);
for(let i=0;i<101;i++)assert.equal((await smallLibrary.fetch(new Request('https://library/save',{method:'POST',body:JSON.stringify(run(capacityBase+i))}))).status,201);
assert.equal((await (await smallLibrary.fetch(new Request('https://library/list'))).json()).grids.length,100);

// An older browser can append slots through /start; enforce the same cap before
// paid reservation, even when it expands an existing rather than a new grid.
const expansionStorage=new MemoryStorage(),expansionLibrary=new ComparisonLibrary({storage:expansionStorage},env);
const expansionCall=(path,input={})=>expansionLibrary.fetch(new Request('https://library'+path,{method:'POST',body:JSON.stringify(input)}));
const oldest=run(capacityBase);assert.equal((await expansionCall('/save',oldest)).status,201);
for(let i=1;i<=31;i++)assert.equal((await expansionCall('/save',manyRun(capacityBase+i,80))).status,201);
assert.equal((await expansionCall('/save',manyRun(capacityBase+32,19))).status,201);
const addInput={id:crypto.randomUUID(),batchID:oldest.id,description:oldest.prompt,age:7,composition:oldest.composition,model:oldest.cells[0].model};
const beforeExpansion=reservations;
assert.equal((await expansionCall('/start',addInput)).status,410);assert.equal(reservations,beforeExpansion);
assert.equal(await expansionStorage.get('image:'+addInput.id),undefined);
assert.equal((await (await expansionCall('/list')).json()).imageCount,2500);
assert.equal((await (await expansionCall('/get',{id:oldest.id})).json()).grid.cells.length,1);
console.log('PASS: weighted capacity, multiple whole-grid evictions, old imports, restart persistence, legacy migration, existing grid limit and legacy-tab expansion before spending.');
