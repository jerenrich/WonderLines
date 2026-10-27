import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import {getPrincipal, createSession} from '../src/auth.mjs';
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
const env={LAB_ACCESS_KEY:'test-private-key',LAB_ACCOUNT_ID:accountId,LOGIN_LIMITER:{limit:async()=>({success:true})},GENERATION_LIMITER:{limit:async()=>({success:true})},ACCOUNTS:{idFromName:id=>{assert.equal(id,accountId);return id;},get:()=>stub},GENERATIONS:{get:async key=>{assert.match(key,new RegExp('^'+accountId+'/'));return {body:new Uint8Array([137,80,78,71])};}},ASSETS:{fetch:async()=>new Response('<html>Public login shell</html>')}};
const library=new ComparisonLibrary({storage:new MemoryStorage()},env);
env.LIBRARY={idFromName:id=>id,get:()=>({fetch:(url,options)=>library.fetch(new Request(url,options))})};
const request=(path,method='GET',input,cookie,extra={})=>new Request(origin+path,{method,headers:{'Content-Type':'application/json',...(method!=='GET'?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...extra},...(input!==undefined?{body:JSON.stringify(input)}:{})});
assert.equal((await worker.fetch(request('/'),env)).status,200);
for(const path of ['/api/config','/api/generations/'+crypto.randomUUID(),'/api/images/'+crypto.randomUUID()])assert.equal((await worker.fetch(request(path),env)).status,401);
assert.equal(calls.length,0);
assert.equal((await worker.fetch(request('/api/session','POST',{key:'wrong'}),env)).status,401);
assert.equal((await worker.fetch(request('/api/session','POST',{key:env.LAB_ACCESS_KEY},null,{Origin:'https://evil.example'}),env)).status,403);
assert.equal((await worker.fetch(request('/api/session','POST',{key:env.LAB_ACCESS_KEY}),{...env,LOGIN_LIMITER:{limit:async()=>({success:false})}})).status,429);
const login=await worker.fetch(request('/api/session','POST',{key:env.LAB_ACCESS_KEY,remember:true}),env);
assert.equal(login.status,200); const header=login.headers.get('Set-Cookie'),cookie=header.split(';')[0];
assert.match(header,/HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);assert.ok(!header.includes(env.LAB_ACCESS_KEY));
assert.equal((await (await worker.fetch(request('/api/session','GET',undefined,cookie),env)).json()).authenticated,true);
assert.equal(await getPrincipal(request('/api/config','GET',undefined,cookie),{...env,LAB_ACCESS_KEY:'rotated'}),null);
assert.equal(await getPrincipal(request('/api/config','GET',undefined,cookie+'x'),env),null);
assert.ok(!(await createSession(env,false)).includes('Max-Age'));
const config=await (await worker.fetch(request('/api/config','GET',undefined,cookie),env)).json();
assert.equal(config.models.length,12);assert.equal(config.models.filter(x=>x.recommended).length,6);assert.ok(!JSON.stringify(config).includes('PRIVATE_CREDENTIAL'));
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
const job=jobs.get(input.id);job.state='completed';job.objectKey=accountId+'/'+input.id+'.png';job.metrics={elapsedMs:1200};
const read=await (await worker.fetch(request('/api/generations/'+input.id,'GET',undefined,cookie),env)).json();assert.equal(read.imageUrl,'/api/images/'+input.id);assert.ok(!JSON.stringify(read).includes('objectKey'));
const image=await worker.fetch(request('/api/images/'+input.id,'GET',undefined,cookie),env);assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/png');assert.equal(image.headers.get('Cache-Control'),'no-store');
job.objectKey='someone-else/private.png';assert.equal((await worker.fetch(request('/api/images/'+input.id,'GET',undefined,cookie),env)).status,404);
const limited={...env,GENERATION_LIMITER:{limit:async()=>({success:false})}};
const limitedLibrary=new ComparisonLibrary({storage:new MemoryStorage()},limited);
limited.LIBRARY={idFromName:id=>id,get:()=>({fetch:(url,options)=>limitedLibrary.fetch(new Request(url,options))})};
assert.equal((await worker.fetch(request('/api/generations','POST',{...input,id:crypto.randomUUID()},cookie),limited)).status,429);
const huge=new Request(origin+'/api/generations',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...input,description:'x'.repeat(5000)})});assert.equal((await worker.fetch(huge,env)).status,413);
const logout=await worker.fetch(request('/api/session','DELETE',undefined,cookie),env);assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);
assert.equal((await worker.fetch(request('/api/config'),{...env,LAB_ACCESS_KEY:''})).status,503);
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
