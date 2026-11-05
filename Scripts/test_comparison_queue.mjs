import assert from 'node:assert/strict';
import {Account} from '../workers/coloring-sheets-api/src/index.mjs';
class Storage {
  constructor(){this.values=new Map();}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async delete(key){this.values.delete(key);}
  async list({prefix,limit=Infinity}){return new Map([...this.values].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  async setAlarm(time){this.alarm=time;}
  async getAlarm(){return this.alarm??null;}
  async transaction(callback){return callback(this);}
}
const storage=new Storage(),id=crypto.randomUUID();await storage.put('account',{id});
const env={COMPARISON_ACCOUNT_ID:id,COMPARISON_RUNNERS:{}};
let account=new Account({storage},env);
const started=new Set(),handoffs=[];
const handoff=async imageId=>{started.add(imageId);handoffs.push(imageId);};
account.advanceImage=handoff;
for(let i=0;i<60;i++)await storage.put('image:'+String(i).padStart(3,'0'),String(i).padStart(3,'0'));
await account.runAlarm();assert.equal(started.size,50);
await storage.put('image:000-new-earlier','000-new-earlier');
await Promise.all([account.runAlarm(),account.runAlarm()]);
assert.equal(started.size,50,'New UUID ordering and overlapping watchdogs cannot exceed the slot limit.');
await storage.delete('image:001');await account.runAlarm();
assert.equal(started.size,51,'A single completed image frees one slot without waiting for other models.');
assert.ok(started.has('000-new-earlier'));
assert.equal((await storage.get('comparison-active')).length,50);
// Slot ownership survives an account object restart.
account=new Account({storage},env);account.advanceImage=handoff;await account.runAlarm();assert.equal(started.size,51);
// A partially occupied pool accepts a late reservation without waiting for a peer.
for(const key of [...storage.values.keys()])if(key.startsWith('image:'))await storage.delete(key);
await storage.put('image:late-a','late-a');await account.runAlarm();
await storage.put('image:late-b','late-b');await account.runAlarm();assert.ok(started.has('late-b'));
// Regular app accounts retain their existing three-image concurrency.
const otherStorage=new Storage();await otherStorage.put('account',{id:crypto.randomUUID()});
const ordinary=new Account({storage:otherStorage},env);let ordinaryCalls=0;
ordinary.advanceImage=async imageId=>{ordinaryCalls++;await otherStorage.delete('image:'+imageId);};
for(let i=0;i<8;i++)await otherStorage.put('image:'+i,String(i));
await ordinary.runAlarm();assert.equal(ordinaryCalls,3);assert.equal((await otherStorage.list({prefix:'image:'})).size,5);
console.log('PASS: 50 independent comparison slots, slot refill without slow-peer blocking, late arrivals, overlapping watchdogs, UUID ordering, durable slot recovery, and unchanged app concurrency; no network.');

// Exercise real reservation/completion scheduling, including events which land
// while a dispatch pass is awaiting runner handoffs. No provider is contacted.
const originalNow=Date.now;
try {
  let now=originalNow();Date.now=()=>now;
  const storage=new Storage(),accountId=crypto.randomUUID();await storage.put('account',{id:accountId});
  const env={COMPARISON_ACCOUNT_ID:accountId,COMPARISON_RUNNERS:{},GLOBAL_DAILY_GENERATION_LIMIT:'1000',
    BUDGET:{idFromName:id=>id,get:()=>({fetch:async()=>Response.json({reserved:true})})}};
  const account=new Account({storage},env);
  const reserve=async()=>{
    const id=crypto.randomUUID();
    const response=await account.reserve({generationId:id,fingerprint:id,imageTask:{route:{provider:'openai',model:'gpt-image-2.5-flare'}}});
    assert.equal(response.status,201);return id;
  };
  const first=await reserve(),firstAlarm=storage.alarm;
  assert.equal(firstAlarm,now+1,'Comparison admission requests immediate dispatch.');
  now+=100;await reserve();
  assert.equal(storage.alarm,firstAlarm,'A new arrival must not postpone an earlier alarm.');
  // The watchdog at the start of a pass must also preserve an existing wake-up.
  account.advanceImage=async()=>{};await account.runAlarm();assert.equal(storage.alarm,firstAlarm);
  storage.alarm=null; // Cloudflare consumes the alarm before entering its handler.
  let late;
  account.advanceImage=async id=>{if(id===first){now+=10;late=await reserve();}};
  await account.runAlarm();
  assert.ok(late);assert.equal(storage.alarm,now+1,'The fallback cannot overwrite an arrival during dispatch.');

  // The real handoff records its first dispatch before contacting the runner.
  // An ambiguous/failed handoff and account restart must reuse that boundary.
  const sent=[];let rejectHandoff=true;
  env.COMPARISON_RUNNERS={idFromName:name=>name,get:()=>({fetch:async(url,options)=>{
    sent.push(JSON.parse(options.body));return Response.json({}, {status:rejectHandoff?503:202});
  }})};
  let restored=new Account({storage},env);
  await assert.rejects(restored.advanceImage(first));
  const dispatchedAt=now;assert.equal(sent.at(-1).dispatchedAt,dispatchedAt);
  assert.equal(sent.at(-1).createdAt,(await storage.get('job:'+first)).createdAt);
  now+=100;rejectHandoff=false;restored=new Account({storage},env);
  await restored.advanceImage(first);assert.equal(sent.at(-1).dispatchedAt,dispatchedAt);

  // Fill all 50 slots. Completion during a handoff must wake the dispatcher
  // immediately and the next pass must admit the 51st image.
  const fullStorage=new Storage();await fullStorage.put('account',{id:accountId});
  let full=new Account({storage:fullStorage},env);
  const ids=Array.from({length:51},(_,i)=>String(i).padStart(3,'0'));
  for(const id of ids){
    await fullStorage.put('image:'+id,id);
    await fullStorage.put('job:'+id,{id,state:'processing',imageTask:{stage:'queued'}});
  }
  let release,entered;
  const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),seen=new Set();
  full.advanceImage=async id=>{seen.add(id);if(id===ids[0]){entered();await blocked;}};
  const dispatch=full.runAlarm();await started;
  now+=100;
  assert.equal((await full.complete({generationId:ids[1],result:{state:'failed',errorCode:'synthetic'}})).status,200);
  assert.equal(fullStorage.alarm,now+1);
  release();await dispatch;
  assert.equal(fullStorage.alarm,now+1,'The dispatch fallback cannot postpone a completion wake-up.');
  assert.equal(seen.size,50);
  fullStorage.alarm=null;
  // Recover slot ownership and pending work after an account restart.
  full=new Account({storage:fullStorage},env);full.advanceImage=async id=>seen.add(id);
  await full.runAlarm();assert.ok(seen.has(ids[50]));

  const ordinaryStorage=new Storage();await ordinaryStorage.put('account',{id:crypto.randomUUID()});
  const ordinary=new Account({storage:ordinaryStorage},env);
  const ordinaryReserve=()=>ordinary.reserve({generationId:crypto.randomUUID(),fingerprint:'test',imageTask:{route:{provider:'openai'}}});
  assert.equal((await ordinaryReserve()).status,201);assert.equal(ordinaryStorage.alarm,now+1000);
  now+=100;await ordinaryReserve();assert.equal(ordinaryStorage.alarm,now+900,'Ordinary arrivals also retain the earliest alarm.');
  // Interrupted handoffs retain a durable watchdog for recovery.
  fullStorage.alarm=null;full.advanceImage=async()=>{throw new Error('Synthetic handoff failure');};
  await assert.rejects(full.runAlarm());assert.equal(fullStorage.alarm,now+30000);
  console.log('PASS: immediate comparison admission, burst deadlines, arrivals/completions during dispatch, automatic slot refill after restart, ordinary admission delay and recovery watchdogs; no network.');
} finally {Date.now=originalNow;}
