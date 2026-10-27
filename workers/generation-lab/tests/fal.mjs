import assert from 'node:assert/strict';
import {ComparisonImageRunner} from '../../coloring-sheets-api/src/comparison-image-runner.mjs';
import {Account,Budget} from '../../coloring-sheets-api/src/index.mjs';
import {modelCatalog,imageRequest,submitFalRequest,pollFalRequest} from '../../coloring-sheets-api/src/image-provider.mjs';
import {FAL_COMPARISON_MODELS} from '../../coloring-sheets-api/src/fal-models.mjs';
import {falCostData} from '../../coloring-sheets-api/src/fal-cost.mjs';
import {MemoryStorage} from './storage.mjs';

const accountId=crypto.randomUUID(),images=new Map(),reports=[];
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
const env={COMPARISON_ACCOUNT_ID:accountId,FAL_KEY:'PRIVATE-FAL-KEY',FAL_DAILY_GENERATION_LIMIT:'50',
  AI_GATEWAY_ACCOUNT_ID:'a'.repeat(32),AI_GATEWAY_ID:'coloring-sheets',AI_GATEWAY_TOKEN:'PRIVATE-GATEWAY-KEY',
  GENERATIONS:{put:async(key,value)=>images.set(key,value),get:async key=>images.get(key),delete:async key=>images.delete(key)},
  ACCOUNTS:{idFromName:id=>id,get:()=>({fetch:async(url,options)=>{reports.push(JSON.parse(options.body));return Response.json({});}})}};
const savedFetch=globalThis.fetch,savedInfo=console.info;console.info=()=>{};
let submissions=0,completed=false,downloadFailed=false,unsafe=false,imageURL='https://v3.fal.media/files/test.png',currentEndpoint;
globalThis.fetch=async(url,init={})=>{
  if(url.startsWith('https://api.fal.ai/')){
    const endpoint=new URL(url).searchParams.get('endpoint_id');
    return Response.json(url.includes('/pricing?')?{prices:[{endpoint_id:endpoint,unit_price:0.005,unit:'megapixels',currency:'USD'}]}:
      {has_more:false,billing_events:[{request_id:'job-1',endpoint_id:endpoint,output_units:1,unit_price:0.005,cost_total:0.005,cost_subtotal:0.005,cost_discount:0}]});
  }
  if(url===imageURL){
    assert.equal(init.headers,undefined,'CDN fetches have no provider credentials.');
    if(downloadFailed)return new Response('',{status:503});
    return new Response(png,{headers:{'Content-Type':'image/png'}});
  }
  assert.equal(url,'https://gateway.ai.cloudflare.com/v1/'+env.AI_GATEWAY_ACCOUNT_ID+'/coloring-sheets/fal');
  const headers=new Headers(init.headers),target=headers.get('x-fal-target-url');
  assert.equal(headers.get('cf-aig-collect-log'),'false');assert.equal(headers.get('cf-aig-max-attempts'),'1');
  assert.equal(headers.get('Authorization'),'Key '+env.FAL_KEY);assert.equal(init.redirect,'manual');
  if(init.method==='POST'){
    submissions++;assert.equal(target,'https://queue.fal.run/'+currentEndpoint);
    return Response.json({request_id:'job-1',status_url:'https://evil.example/ignored'});
  }
  const root='https://queue.fal.run/'+currentEndpoint.split('/').slice(0,2).join('/')+'/requests/job-1';
  if(target.endsWith('/status')){assert.equal(target,root+'/status');return Response.json({status:completed?'COMPLETED':'IN_QUEUE',metrics:{inference_time:2}});}
  assert.equal(target,root);
  return Response.json({images:[{url:imageURL}],has_nsfw_concepts:[unsafe],seed:7},{headers:{'x-fal-billable-units':'1'}});
};
try{
  const appIDs=Object.keys(modelCatalog({}).routes);
  for(const [id,config] of Object.entries(FAL_COMPARISON_MODELS)){
    assert.ok(!appIDs.includes(id),'The app picker stays unchanged.');
    const route=modelCatalog({},{comparison:true}).routes[id];assert.equal(route.model,config.model);
    const request=imageRequest(env,route,'A friendly car',{width:1456,height:1024});
    assert.equal(request.payload.output_format,'png');assert.equal(request.payload.enable_safety_checker,true);
    assert.equal(request.payload.num_images,1);assert.ok(request.payload.image_size.width*request.payload.image_size.height<=1060000);
    assert.ok(!JSON.stringify(request).includes(env.FAL_KEY),'Durable fal descriptors contain no credentials.');
    if('enable_prompt_expansion' in request.payload)assert.equal(request.payload.enable_prompt_expansion,false);
    if(id==='z-image-turbo')assert.equal(request.payload.negative_prompt,undefined);
    currentEndpoint=config.model;await submitFalRequest(env,request);
    assert.equal(await pollFalRequest(env,'job-1',config.model),null);
  }
  assert.throws(()=>modelCatalog({IMAGE_MODEL_ROUTES:JSON.stringify({bad:{provider:'fal',model:'fal-ai/arbitrary'}})}));
  assert.throws(()=>imageRequest(env,{provider:'fal',model:'https://evil.example'},'test',{width:1024,height:1024}));
  assert.throws(()=>imageRequest({...env,FAL_KEY:undefined},{provider:'fal',model:'fal-ai/z-image/turbo'},'test',{width:1024,height:1024}));
  currentEndpoint='fal-ai/z-image/turbo';submissions=0;
  const task={id:crypto.randomUUID(),accountId,fingerprint:'test-fingerprint',createdAt:Date.now(),route:{provider:'fal',model:currentEndpoint},subject:'A friendly dinosaur',size:{width:1456,height:1024},publicModel:'z-image-turbo'};
  const storage=new MemoryStorage(),start=new Request('https://runner/start',{method:'POST',body:JSON.stringify(task)});
  let runner=new ComparisonImageRunner({storage},env);assert.equal((await runner.fetch(start)).status,202);
  await runner.alarm();assert.equal(submissions,1);assert.equal((await storage.get('task')).stage,'polling');
  assert.equal((await storage.get('task')).falRequestID,'job-1');
  assert.ok(!JSON.stringify(await storage.get('task')).includes(env.FAL_KEY));
  // A new object instance recovers the same request after queueing and a failed download.
  runner=new ComparisonImageRunner({storage},env);await runner.alarm();assert.equal(submissions,1);
  completed=true;downloadFailed=true;await runner.alarm();assert.equal((await storage.get('task')).stage,'polling');
  downloadFailed=false;await runner.alarm();assert.equal(submissions,1);assert.equal((await storage.get('task')).stage,'done');
  assert.equal(reports.at(-1).result.metrics.upstreamModel,currentEndpoint);
  assert.equal(reports.at(-1).result.metrics.estimatedTotalUsd,0.005);
  assert.equal(reports.at(-1).result.metrics.costStatus,'reported');
  assert.equal(reports.at(-1).result.metrics.inferenceMs,2000);
  await runner.alarm();assert.equal(submissions,1);
  const ambiguous=new MemoryStorage();await ambiguous.put('task',{...task,id:crypto.randomUUID(),stage:'submitting'});
  await new ComparisonImageRunner({storage:ambiguous},env).alarm();assert.equal(submissions,1);assert.equal(reports.at(-1).result.state,'failed');
  unsafe=true;await assert.rejects(()=>pollFalRequest(env,'job-1',currentEndpoint),error=>error.code==='provider_content_rejected');unsafe=false;
  imageURL='https://evil.example/private.png';await assert.rejects(()=>pollFalRequest(env,'job-1',currentEndpoint));
  const cost=await falCostData(env,'job-1',null,Date.now(),currentEndpoint);assert.equal(cost.reportedCostUsd,0.005);
  // New fal comparison jobs obey the pre-existing provider daily limit.
  const budgetEnv={GLOBAL_DAILY_GENERATION_LIMIT:'100',FAL_DAILY_GENERATION_LIMIT:'1',FREE_DAILY_ALLOWANCE:'100'};
  const budget=new Budget({storage:new MemoryStorage()},budgetEnv);
  budgetEnv.BUDGET={idFromName:id=>id,get:()=>({fetch:(url,init)=>budget.fetch(new Request(url,init))})};
  const accountStorage=new MemoryStorage();await accountStorage.put('account',{id:accountId});
  const account=new Account({storage:accountStorage},budgetEnv);
  const reserve=()=>account.reserve({generationId:crypto.randomUUID(),fingerprint:'test',imageTask:{route:task.route}});
  assert.equal((await reserve()).status,201);assert.equal((await reserve()).status,429);
  console.log('PASS: all fal presets, comparison-only catalogue, native queue paths, safe payloads, durable request recovery, download retries without resubmission, exact-model billing, CDN and content checks, and fal spend limits; no paid calls.');
}finally{globalThis.fetch=savedFetch;console.info=savedInfo;}
