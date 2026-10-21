import assert from 'node:assert/strict';
import {Account} from '../workers/coloring-sheets-api/src/index.mjs';
class Storage {
  constructor(){this.values=new Map();}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async delete(key){this.values.delete(key);}
  async list({prefix,limit=Infinity}){return new Map([...this.values].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  async setAlarm(time){this.alarm=time;}
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
