// Offline public-API regression tests: no provider, email or real user data.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import {safeModerationResult} from './test_moderation.mjs';
class Storage {
  values = new Map();
  async get(k) { return structuredClone(this.values.get(k)); }
  async put(k, v) { this.values.set(k, structuredClone(v)); }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.values.delete(key); }
  async setAlarm(time) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(fn) { return fn(this); }
  async list({prefix = '', limit = Infinity} = {}) {
    return new Map([...this.values].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([k,v]) => [k, structuredClone(v)]));
  }
}
class Namespace {
  objects = new Map();
  constructor(Type, env) { this.Type = Type; this.env = env; }
  idFromName(id) { return id; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new this.Type({storage: new Storage()}, this.env));
    return {fetch: (url, init) => this.objects.get(id).fetch(new Request(url, init))};
  }
}
class Bucket {
  values = new Map();
  async put(key, value) { if(this.failPut) {this.failPut=false; throw new Error("synthetic report storage interruption");} this.values.set(key, value); }
  async get(key) { const v=this.values.get(key); return v && {body:new Response(v).body}; }
  async list({prefix, limit}) { return {objects:[...this.values.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(key=>({key}))}; }
  async delete(keys) {
    if (this.failDelete) { this.failDelete=false; throw new Error('synthetic storage interruption'); }
    for (const k of Array.isArray(keys)?keys:[keys]) this.values.delete(k);
  }
}
const env={REGISTRATION_LIMITER:{limit:async()=>({success:true})},ACCOUNT_TOKEN_SECRET:'synthetic-secret',OPENAI_API_KEY:'synthetic-provider',FREE_DAILY_ALLOWANCE:'100',GLOBAL_DAILY_GENERATION_LIMIT:'1000',MODERATION_GATEWAY_ID:'synthetic',AI:{run:async()=>safeModerationResult()}};
env.ACCOUNTS=new Namespace(Account,env); env.BUDGET=new Namespace(Budget,env); env.GENERATIONS=new Bucket();
const realFetch=globalThis.fetch, realInfo=console.info;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
let hold, providerStarted, providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;providerStarted?.();if(hold)await hold;return Response.json({data:[{b64_json:png}]});};
console.info=()=>{};
const api=(path,who,method='GET',value,headers={})=>worker.fetch(new Request('https://test'+path,{method,headers:{...(who?{Authorization:'Bearer '+who.accessToken}:{}),...(value?{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'}:{}),...headers},...(value?{body:JSON.stringify(value)}:{})}),env);
const register=async()=>await(await api('/v1/installations',null,'POST',{})).json();
const generate=(who,id,queued=false)=>api('/v1/generations',who,'POST',{subject:'Synthetic flower',model:'gpt-image-2.5-flare',width:1456,height:1024},{'Idempotency-Key':id,...(queued?{'X-Coloring-API-Version':'2'}:{})});
const until=async(predicate)=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,1));}throw new Error('Timed out');};
try {
  const a=await register(), b=await register(), id=crypto.randomUUID();
  assert.equal((await generate(a,id)).status,200);
  const path='/v1/generations/'+id+'/report';
  assert.equal((await api(path,null,'POST',{reason:'other'})).status,401);
  assert.equal((await api(path,b,'POST',{reason:'other'})).status,404);
  assert.equal((await api(path,a,'POST',{reason:'invalid'})).status,400);
  env.GENERATIONS.failPut=true;
  assert.equal((await api(path,a,'POST',{reason:'violence'})).status,503);
  assert.equal((await api('/v1/generations/'+id,a)).status,200,'Failed reports must be retryable');
  assert.equal((await api(path,a,'POST',{reason:'violence'})).status,201);
  assert.equal((await api(path,a,'POST',{reason:'violence'})).status,200);
  assert.equal((await api('/v1/generations/'+id,a)).status,410);
  const reportKey='reports/'+a.accountId+'/'+id+'.json';
  assert.equal(JSON.parse(env.GENERATIONS.values.get(reportKey)).reason,'violence');
  assert.equal((await api('/v1/account',null,'DELETE')).status,401);
  env.GENERATIONS.failDelete=true;
  assert.equal((await api('/v1/account',a,'DELETE')).status,503);
  assert.equal((await api('/v1/access',a)).status,401,'Deletion revokes access even if storage cleanup must retry');
  await env.ACCOUNTS.objects.get(a.accountId).alarm();
  assert.deepEqual(await(await api('/v1/account',a,'DELETE')).json(),{deleted:true});
  assert.equal(env.GENERATIONS.values.size,0);
  assert.deepEqual([...env.ACCOUNTS.objects.get(a.accountId).state.storage.values.keys()],['deletion']);
  const budget=env.BUDGET.objects.get('daily-generation-budget');
  assert.equal([...budget.state.storage.values.keys()].some(k=>k.includes(a.accountId)),false);
  assert.equal((await api('/v1/installations/renew',a,'POST',{})).status,410,'A deleted account tells the app to start a new one');
  assert.equal((await api('/v1/access',b)).status,200,'Another account must be unaffected');

  // A legacy request outside the DO must not write an orphan image after deletion.
  const c=await register(); let release;
  hold=new Promise(r=>release=r); const started=new Promise(r=>providerStarted=r);
  const legacy=generate(c,crypto.randomUUID()); await started;
  assert.equal((await api('/v1/account',c,'DELETE')).status,200);
  release(); await legacy; hold=null; providerStarted=null;
  assert.equal(env.GENERATIONS.values.size,0);

  // A provider result already in a DO alarm must drain before cleanup completes.
  const d=await register(), job=crypto.randomUUID();
  assert.equal((await generate(d,job,true)).status,202);
  hold=new Promise(r=>release=r); const queuedStarted=new Promise(r=>providerStarted=r);
  const object=env.ACCOUNTS.objects.get(d.accountId); const alarm=object.alarm(); await queuedStarted;
  const deletion=api('/v1/account',d,'DELETE');
  await until(()=>object.state.storage.get('deletion'));
  assert.equal((await api('/v1/access',d)).status,401);
  release(); assert.equal((await deletion).status,200); await alarm;
  hold=null; providerStarted=null;
  assert.equal(env.GENERATIONS.values.size,0);
  assert.deepEqual([...object.state.storage.values.keys()],['deletion']);
  let marker=await object.state.storage.get('deletion'); marker.startedAt=Date.now()-86400001;
  await object.state.storage.put('deletion',marker); await object.alarm();
  assert.equal(object.state.storage.values.size,0,'The temporary tombstone expires too');
  assert.equal((await api('/v1/account',d,'DELETE')).status,200);
  const expired=await register();
  const payload=JSON.parse(Buffer.from(expired.accessToken.split('.')[0],'base64url').toString());
  payload.exp=1;
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  expired.accessToken=encoded+'.'+createHmac('sha256',env.ACCOUNT_TOKEN_SECRET).update(encoded).digest('base64url');
  assert.equal((await api('/v1/access',expired)).status,401);
  assert.equal((await api('/v1/account',expired,'DELETE')).status,200,'Authentic expired credentials can still delete');
  assert.equal(providerCalls,3,'Reporting/deletion never generates another image');
} finally {globalThis.fetch=realFetch;console.info=realInfo;}
console.log('PASS: authenticated reporting, cross-account isolation, durable queue, idempotency, revoked access, interrupted deletion retry, account/image/report/claim cleanup, in-flight legacy and queued work, and tombstone expiry; no network.');
