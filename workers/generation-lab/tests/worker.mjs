import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import {SignJWT} from 'jose';
import {comparisonPrincipal, ADMIN_EMAIL} from '../src/admin-auth.mjs';
import {ComparisonLibrary} from '../src/library.mjs';
import {MemoryStorage} from './storage.mjs';
const origin='https://compare.example';
const accountId='f66c3047-7ae6-4a1d-9144-7514e7a44961';
const jobs=new Map(), calls=[]; let initialized=false, approved=true, reservations=0;
const access={freeGenerationsRemaining:100};
const stub={fetch:async(url,options)=>{
  const path=new URL(url).pathname, input=JSON.parse(options.body); calls.push({path,input});
  if(path==='/access')return Response.json(initialized?{access}:{error:{}},{status:initialized?200:404});
  if(path==='/initialize'){initialized=true;return Response.json({credentialId:'PRIVATE_CREDENTIAL',access},{status:201});}
  if(path==='/moderate-batch')return Response.json(approved?{approved:true}:{error:{code:'description_not_suitable',message:'Choose another description.'}},{status:approved?200:400});
  if(path==='/job')return Response.json(jobs.has(input.generationId)?{job:jobs.get(input.generationId),access}:{error:{}},{status:jobs.has(input.generationId)?200:404});
  if(path==='/reserve'){
    reservations++;
    const job={id:input.generationId,fingerprint:input.fingerprint,state:'processing',createdAt:Date.now(),imageTask:input.imageTask};jobs.set(job.id,job);
    return Response.json({job,access},{status:201});
  }
  throw Error('Unexpected account route '+path);
}};
const env={MODEL_ADMIN_ORIGIN:origin,GOOGLE_CLIENT_ID:'synthetic-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-secret',MODEL_ADMIN_SESSION_SECRET:'synthetic-admin-session-secret-at-least-32-characters',LAB_ACCESS_KEY:'test-private-key',LAB_ACCOUNT_ID:accountId,LOGIN_LIMITER:{limit:async()=>({success:true})},GENERATION_LIMITER:{limit:async()=>({success:true})},ACCOUNTS:{idFromName:id=>{assert.equal(id,accountId);return id;},get:()=>stub},GENERATIONS:{get:async key=>{assert.match(key,new RegExp('^'+accountId+'/'));return {body:new Uint8Array([137,80,78,71])};}},ASSETS:{fetch:async()=>new Response('<html>Public login shell</html>')}};
const library=new ComparisonLibrary({storage:new MemoryStorage()},env);
env.LIBRARY={idFromName:id=>id,get:()=>({fetch:(url,options)=>library.fetch(new Request(url,options))})};
const request=(path,method='GET',input,cookie,extra={})=>new Request(origin+path,{method,headers:{'Content-Type':'application/json',...(method!=='GET'?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...extra},...(input!==undefined?{body:JSON.stringify(input)}:{})});
assert.equal((await worker.fetch(request('/'),env)).status,200);
for(const path of ['/api/config','/api/generations/'+crypto.randomUUID(),'/api/images/'+crypto.randomUUID()])assert.equal((await worker.fetch(request(path),env)).status,401);
assert.equal(calls.length,0);
assert.equal((await worker.fetch(request('/api/session','POST',{key:env.LAB_ACCESS_KEY}),env)).status,405);
assert.equal((await worker.fetch(request('/api/session','DELETE',undefined,null,{Origin:'https://evil.example'}),env)).status,403);
const signed=await new SignJWT({purpose:'session',email:ADMIN_EMAIL}).setProtectedHeader({alg:'HS256'}).setIssuer('wonderlines-model-admin').setAudience(env.GOOGLE_CLIENT_ID).setSubject('google-user').setIssuedAt().setExpirationTime('8h').sign(new TextEncoder().encode(env.MODEL_ADMIN_SESSION_SECRET));
const cookie='__Host-wonderlines_admin='+signed;
assert.equal((await (await worker.fetch(request('/api/session','GET',undefined,cookie),env)).json()).authenticated,true);
assert.equal(await comparisonPrincipal(request('/api/config','GET',undefined,cookie),{...env,MODEL_ADMIN_SESSION_SECRET:'rotated-secret-at-least-32-characters'}),null);
assert.equal(await comparisonPrincipal(request('/api/config','GET',undefined,cookie+'x'),env),null);
const config=await (await worker.fetch(request('/api/config','GET',undefined,cookie),env)).json();
assert.equal(config.models.length,24);assert.equal(config.models.filter(x=>x.recommended).length,6);assert.ok(!JSON.stringify(config).includes('PRIVATE_CREDENTIAL'));
assert.ok(config.models.some(x=>x.id==='sana-sprint'&&x.provider==='fal'));
// Klein's distinct distilled/base checkpoints must be visibly distinguishable.
for(const size of ['4b','9b']){
  const fast=config.models.find(x=>x.id==='flux-2-klein-'+size);
  const base=config.models.find(x=>x.id==='flux-2-klein-base-'+size);
  assert.match(fast.label,/Fast, 4 steps/);assert.match(base.label,/Base, 28 steps/);
  assert.equal(fast.provider,'workers-ai');assert.equal(base.provider,'fal');
  assert.notEqual(fast.model,base.model);assert.notEqual(fast.label,base.label);
}
assert.ok(config.unavailableModels.some(x=>x.label==='Flex.2-preview'));
const input={id:crypto.randomUUID(),batchID:crypto.randomUUID(),description:'A friendly dinosaur gardening',age:4,composition:'front',model:'flux-2-klein-4b'};
const post=(data=input,headers={})=>worker.fetch(request('/api/generations','POST',data,cookie,headers),env);
assert.equal((await post({...input,age:2})).status,400);
assert.equal((await post({...input,age:19})).status,400);
assert.equal((await post({...input,model:'https://evil.example'})).status,400);
assert.equal((await post({...input,description:'x'.repeat(500)})).status,400);
assert.equal((await post(input,{Origin:'https://evil.example'})).status,403);
assert.equal(reservations,0);
approved=false;assert.equal((await post()).status,400);assert.equal(reservations,0);approved=true;
const started=await post(); assert.equal(started.status,202);const data=await started.json();
assert.equal(data.status,'processing');assert.equal(reservations,1);assert.ok(!JSON.stringify(data).includes('imageTask'));
assert.match(calls.find(x=>x.path==='/reserve').input.imageTask.subject,/very simple outlines/);
assert.deepEqual(calls.find(x=>x.path==='/reserve').input.imageTask.size,{width:1456,height:1024});
assert.equal((await post()).status,200);assert.equal(reservations,1);
assert.equal((await post({...input,age:15})).status,409);assert.equal(reservations,1);
const second={...input,id:crypto.randomUUID(),age:15};assert.equal((await post(second)).status,202);
assert.match(calls.filter(x=>x.path==='/reserve').at(-1).input.imageTask.subject,/intricate outlines/);
const falInput={...input,id:crypto.randomUUID(),batchID:crypto.randomUUID(),model:'z-image-turbo'};
assert.equal((await post(falInput)).status,202);
const falReservation=calls.filter(x=>x.path==='/reserve').at(-1).input;
assert.equal(falReservation.imageTask.route.model,'fal-ai/z-image/turbo');
assert.equal(falReservation.falTask,undefined,'Comparison queues carry routes, never provider credentials or prebuilt paid submissions.');
const job=jobs.get(input.id);job.state='completed';job.objectKey=accountId+'/'+input.id+'.png';job.metrics={elapsedMs:1200};
const read=await (await worker.fetch(request('/api/generations/'+input.id,'GET',undefined,cookie),env)).json();assert.equal(read.imageUrl,'/api/images/'+input.id);assert.ok(!JSON.stringify(read).includes('objectKey'));
const image=await worker.fetch(request('/api/images/'+input.id,'GET',undefined,cookie),env);assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/png');assert.equal(image.headers.get('Cache-Control'),'no-store');
job.objectKey='someone-else/private.png';assert.equal((await worker.fetch(request('/api/images/'+input.id,'GET',undefined,cookie),env)).status,404);
const limited={...env,GENERATION_LIMITER:{limit:async()=>({success:false})}};
const limitedLibrary=new ComparisonLibrary({storage:new MemoryStorage()},limited);
limited.LIBRARY={idFromName:id=>id,get:()=>({fetch:(url,options)=>limitedLibrary.fetch(new Request(url,options))})};
assert.equal((await worker.fetch(request('/api/generations','POST',{...input,id:crypto.randomUUID()},cookie),limited)).status,429);
const huge=new Request(origin+'/api/generations',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...input,description:'x'.repeat(5000)})});assert.equal((await worker.fetch(huge,env)).status,413);
const logout=await worker.fetch(request('/api/session','DELETE',undefined,cookie),env);assert.equal(logout.headers.getSetCookie().filter(value=>value.includes('Max-Age=0')).length,2);
assert.equal((await worker.fetch(request('/api/config'),{...env,LAB_ACCOUNT_ID:''})).status,503);
console.log('PASS: secure sessions, key rotation, CSRF, login throttling, protected images, account isolation, model allowlist, age guidance, moderation before spend, rate limits, bounded requests, queued generation, idempotency and recovery');

// Reading an existing comparison fills estimates using original upstream IDs.
// It must not reserve jobs, change stored evidence, or price failed attempts.
const pricingStorage=new MemoryStorage(),pricingLibrary=new ComparisonLibrary({storage:pricingStorage},env);
const pricingGrid={id:crypto.randomUUID(),cells:[
  {id:crypto.randomUUID(),status:'completed',model:'public-alias',metrics:{provider:'workers-ai',upstreamModel:'@cf/leonardo/phoenix-1.0',size:'1456x1024',estimatedTotalUsd:null}},
  {id:crypto.randomUUID(),status:'failed',metrics:{provider:'workers-ai',upstreamModel:'@cf/leonardo/phoenix-1.0',size:'1456x1024',estimatedTotalUsd:null}},
  {id:crypto.randomUUID(),status:'completed',model:'dreamshaper-8-lcm',metrics:{provider:'workers-ai',upstreamModel:'@cf/lykon/dreamshaper-8-lcm',size:'1456x1024',estimatedTotalUsd:null}}
]};
await pricingStorage.put('grid:'+pricingGrid.id,pricingGrid);
const beforePricingReads=calls.length;
const priced=await (await pricingLibrary.fetch(new Request('https://library/get',{method:'POST',body:JSON.stringify({id:pricingGrid.id})}))).json();
assert.ok(Math.abs(priced.grid.cells[0].metrics.estimatedTotalUsd-0.0429)<1e-12);
assert.match(priced.grid.cells[0].metrics.estimateBasis,/assumes.*25-step/);
assert.equal(priced.grid.cells[1].metrics.estimatedTotalUsd,null);
assert.ok(Math.abs(priced.grid.cells[2].metrics.estimatedTotalUsd-0.000002728)<1e-12);
assert.equal(priced.grid.cells[2].metrics.costEvidence,'observed_neuron_usage');
assert.deepEqual(await pricingStorage.get('grid:'+pricingGrid.id),pricingGrid);
assert.equal(calls.length,beforePricingReads,'Cost enrichment requires no provider or account calls.');
console.log('PASS: saved comparison estimates use upstream evidence without inference, mutation, or failed-image pricing.');

// The comparison picker and library must use the same live registry as admission.
const registry=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../coloring-sheets-api/model-registry.initial.json',import.meta.url)));
registry.models.find(model=>model.id==='gpt-image-2.5-flare').enabled=false;
registry.models.push({id:'new-comparison-model',provider:'openai',model:'gpt-image-2.5-flare',enabled:true,visible:true,label:'New comparison model',detail:'Test model',price:null});
const liveEnv={...env,MODEL_REGISTRY:{get:async()=>JSON.stringify(registry)}};
const liveLibrary=new ComparisonLibrary({storage:new MemoryStorage()},liveEnv);
liveEnv.LIBRARY={idFromName:id=>id,get:()=>({fetch:(url,options)=>liveLibrary.fetch(new Request(url,options))})};
const liveConfig=await (await worker.fetch(request('/api/config','GET',undefined,cookie),liveEnv)).json();
assert.ok(!liveConfig.models.some(model=>model.id==='gpt-image-2.5-flare'));
assert.ok(liveConfig.models.some(model=>model.id==='new-comparison-model'));
const liveGrid={id:crypto.randomUUID(),prompt:'A friendly dinosaur',composition:'front',models:[{id:'new-comparison-model'}],ages:[4],cells:[{id:crypto.randomUUID(),model:'new-comparison-model',age:4}]};
assert.equal((await worker.fetch(request('/api/library','POST',liveGrid,cookie),liveEnv)).status,201);
console.log('PASS: comparison configuration and library accept dynamic registry routes and omit disabled models.');
