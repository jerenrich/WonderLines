// Z-Image Turbo through real app/lab handlers with synthetic providers only.
import assert from 'node:assert/strict';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import {imageRequest, modelCatalog, falQueueURL} from '../workers/coloring-sheets-api/src/image-provider.mjs';
import {falCostData} from '../workers/coloring-sheets-api/src/fal-cost.mjs';
import {imageCost} from '../workers/coloring-sheets-api/src/image-cost.mjs';
import {ComparisonLibrary} from '../workers/generation-lab/src/library.mjs';
import {catalog} from '../workers/generation-lab/src/catalog.mjs';
import {MemoryStorage} from '../workers/generation-lab/tests/storage.mjs';
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const env = {ACCOUNT_TOKEN_SECRET:'synthetic-token',FAL_KEY:'PRIVATE-FAL-KEY',AI_GATEWAY_TOKEN:'PRIVATE-GATEWAY-KEY',
  AI_GATEWAY_ACCOUNT_ID:'a'.repeat(32),AI_GATEWAY_ID:'coloring-sheets',FAL_DAILY_GENERATION_LIMIT:'3',GLOBAL_DAILY_GENERATION_LIMIT:'100',
  REGISTRATION_LIMITER:{limit:async()=>({success:true})},AI:{run:async()=>{throw Error('Unexpected moderation call');}}};
class Namespace {
  objects = new Map();
  constructor(Type) { this.Type=Type; }
  idFromName(id) { return id; }
  get(id) {
    if(!this.objects.has(id))this.objects.set(id,new this.Type({storage:new MemoryStorage()},env));
    return {fetch:(url,init)=>this.objects.get(id).fetch(new Request(url,init))};
  }
}
env.ACCOUNTS=new Namespace(Account);env.BUDGET=new Namespace(Budget);
const images=new Map();env.GENERATIONS={put:async(k,v)=>images.set(k,v),get:async k=>images.has(k)?{body:new Response(images.get(k)).body}:null};
const requests=[],logs=[],originalFetch=globalThis.fetch,originalInfo=console.info;
let state='IN_QUEUE',nsfw=false,reported=false,approved=true;
const upstream='fal-ai/z-image/turbo',route=modelCatalog({}).routes['z-image-turbo'];
assert.deepEqual(route,{provider:'fal',model:'z-image-turbo'});
assert.ok(catalog({}).some(m=>m.id==='z-image-turbo'&&m.label==='Z-Image Turbo'&&m.recommended));
assert.ok(!catalog({}).some(m=>m.id==='coloringbook-redmond-v2'));
assert.throws(()=>falQueueURL('https://evil.example'));
assert.throws(()=>modelCatalog({IMAGE_MODEL_ROUTES:JSON.stringify({bad:{provider:'fal',model:'fal-ai/arbitrary'}})}));
for(const size of [{width:1456,height:1024},{width:1024,height:1456},{width:1024,height:1024}]) {
  const req=imageRequest(env,route,'A friendly flower. Complexity: simple outlines',size);
  assert.equal(req.model,upstream);assert.deepEqual(req.payload.image_size,size);
  assert.equal(req.payload.num_inference_steps,8);assert.equal(req.payload.output_format,'png');
  assert.equal(req.payload.enable_safety_checker,true);assert.equal(req.payload.enable_prompt_expansion,false);
  assert.match(req.payload.prompt,/bold clean black outlines/);assert.match(req.payload.prompt,/Complexity: simple outlines/);
  assert.equal(req.payload.loras,undefined);assert.equal(req.payload.negative_prompt,undefined);
}
console.info=value=>logs.push(JSON.parse(value));
globalThis.fetch=async(url,init)=>{
  requests.push({url,init});assert.equal(init.redirect,'manual');
  if(url.startsWith('https://api.fal.ai/')) {
    const params=new URL(url).searchParams;assert.equal(params.get('endpoint_id'),upstream);
    if(url.includes('/pricing?'))return Response.json({prices:[{endpoint_id:'fal-ai/lora',unit_price:999,unit:'compute second',currency:'USD'},
      {endpoint_id:upstream,unit_price:0.005,unit:'megapixels',currency:'USD'}]});
    return Response.json({has_more:false,billing_events:reported?[{request_id:params.get('request_id'),endpoint_id:upstream,
      output_units:1.5,unit_price:0.005,cost_subtotal:0.0075,cost_discount:0.001,cost_total:0.0065}]:[]});
  }
  if(url.startsWith('https://v3.fal.media/')) {assert.equal(init.headers,undefined);return new Response(png);}
  const headers=new Headers(init.headers),target=headers.get('x-fal-target-url');
  assert.equal(url,'https://gateway.ai.cloudflare.com/v1/'+env.AI_GATEWAY_ACCOUNT_ID+'/coloring-sheets/fal');
  assert.equal(headers.get('Authorization'),'Key '+env.FAL_KEY);
  assert.equal(headers.get('cf-aig-max-attempts'),'1');assert.equal(headers.get('cf-aig-collect-log'),'false');
  if(init.method==='POST') {
    assert.equal(target,'https://queue.fal.run/'+upstream);
    const payload=JSON.parse(init.body);assert.equal(payload.num_images,1);assert.equal(payload.enable_prompt_expansion,false);
    return Response.json({request_id:'z-job-'+requests.filter(r=>r.init.method==='POST').length,status_url:'https://evil.example/ignore'});
  }
  assert.match(target,/^https:\/\/queue.fal.run\/fal-ai\/z-image\/requests\/z-job-\d+(\/status)?$/);
  if(target.endsWith('/status'))return Response.json({status:state,metrics:{inference_time:2}});
  return Response.json({images:[{url:'https://v3.fal.media/files/synthetic.png'}],has_nsfw_concepts:[nsfw],seed:42},
    {headers:{'x-fal-billable-units':'1.5'}});
};
try {
  const registration=await worker.fetch(new Request('https://test/v1/installations',{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.1','Content-Type':'application/json'},body:'{}'}),env);
  const identity=await registration.json(),auth={Authorization:'Bearer '+identity.accessToken};
  let account=env.ACCOUNTS.objects.get(identity.accountId);
  // A prevalidated moderation result lets this test focus on queue/billing. All
  // generation paths still run through the production moderation entry point.
  account.moderateBatch=async()=>approved?Response.json({approved:true}):Response.json({error:{code:'description_not_suitable',message:'Choose another description.'}},{status:400});
  const send=(id)=>worker.fetch(new Request('https://test/v1/generations',{method:'POST',headers:{...auth,'Content-Type':'application/json','Idempotency-Key':id},
    body:JSON.stringify({model:'z-image-turbo',description:'Synthetic flower',age:4,composition:'front',batchID:id,width:1456,height:1024})}),env);
  const id=crypto.randomUUID();
  const before=await account.access();
  const key=env.FAL_KEY;delete env.FAL_KEY;
  assert.equal((await send(id)).status,503);assert.deepEqual(await account.access(),before);env.FAL_KEY=key;
  approved=false;assert.equal((await send(id)).status,400);assert.deepEqual(await account.access(),before);approved=true;
  assert.equal((await send(id)).status,202);assert.equal((await send(id)).status,202);assert.equal(requests.length,0);
  await account.alarm();assert.equal(requests.filter(r=>r.init.method==='POST').length,1);
  const stored=await account.state.storage.get('job:'+id);
  assert.equal(stored.fal.request.model,upstream);assert.ok(!JSON.stringify(stored).includes(key));
  // Simulated eviction preserves native endpoint routing and never resubmits.
  account=new Account(account.state,env);env.ACCOUNTS.objects.set(identity.accountId,account);
  account.moderateBatch=async()=>approved?Response.json({approved:true}):Response.json({error:{code:'description_not_suitable',message:'Choose another description.'}},{status:400});
  await account.alarm();state='COMPLETED';await account.alarm();
  const get=()=>worker.fetch(new Request('https://test/v1/generations/'+id,{headers:auth}),env);
  let response=await get();assert.equal(response.status,200);
  let metrics=JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
  assert.equal(metrics.upstreamModel,upstream);assert.equal(metrics.requestedModel,'z-image-turbo');assert.equal(metrics.inferenceSteps,8);
  assert.equal(metrics.billingUnit,'megapixels');assert.equal(metrics.estimatedTotalUsd,0.0075);
  assert.equal(metrics.size,'1x1');assert.equal(metrics.requestedSize,'1456x1024');
  const beforeRecovery=requests.length;assert.equal((await send(id)).status,200);assert.equal(requests.length,beforeRecovery);
  // Read-only cost refresh selects this endpoint, not Redmond's pricing.
  reported=true;
  const savedJob=await account.state.storage.get('job:'+id);savedJob.metrics.costCheckedAt='2000-01-01T00:00:00Z';
  await account.state.storage.put('job:'+id,savedJob);
  const usage=await(await account.usage({generationId:id})).json();
  assert.equal(usage.metrics.costStatus,'reported');assert.equal(usage.metrics.estimatedTotalUsd,0.0065);
  const billed=await falCostData(env,stored.fal.requestID,1.5,Date.now(),upstream);
  assert.equal(imageCost(stored.fal.request,billed).estimatedTotalUsd,0.0065);reported=false;
  // Without billable units, never multiply inference seconds by a megapixel rate.
  assert.equal(imageCost(stored.fal.request,{inferenceMs:2000,unitPriceUsd:0.005,billingUnit:'megapixels'}).estimatedTotalUsd,null);
  // The website has no provider key; its trusted reservation is validated by Account.
  const labEnv={LAB_ACCOUNT_ID:identity.accountId,ACCOUNTS:env.ACCOUNTS,GENERATION_LIMITER:{limit:async()=>({success:true})}};
  const library=new ComparisonLibrary({storage:new MemoryStorage()},labEnv);
  const labID=crypto.randomUUID(),batchID=crypto.randomUUID();
  const start=()=>library.fetch(new Request('https://library/start',{method:'POST',body:JSON.stringify({id:labID,batchID,description:'Synthetic flower',age:7,composition:'front',model:'z-image-turbo'})}));
  const labBefore=await account.access();delete env.FAL_KEY;
  assert.equal((await start()).status,503);assert.deepEqual(await account.access(),labBefore);env.FAL_KEY=key;
  assert.equal((await start()).status,202);await account.alarm();await account.alarm();
  assert.equal((await account.state.storage.get('job:'+labID)).state,'completed');
  assert.equal((await start()).status,200);
  // Safety rejection is terminal, and the shared fal cap covers app and website.
  nsfw=true;const unsafeID=crypto.randomUUID();assert.equal((await send(unsafeID)).status,202);
  await account.alarm();await account.alarm();
  assert.equal((await account.state.storage.get('job:'+unsafeID)).errorCode,'provider_content_rejected');
  assert.equal((await send(crypto.randomUUID())).status,429);
  assert.equal(requests.filter(r=>r.init.method==='POST').length,3);
  assert.ok(!JSON.stringify(logs).includes(key));
  console.log('PASS: Z-Image app/lab admission, provider preflight before spending, moderation path, shared fal cap, native payload, endpoint-specific polling/billing, durable recovery, safety rejection, no duplicate inference and no credentials in jobs/logs; no network.');
} finally {globalThis.fetch=originalFetch;console.info=originalInfo;}
