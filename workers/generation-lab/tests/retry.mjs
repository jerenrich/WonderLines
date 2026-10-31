import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as costDisplay from '../public/cost-display.mjs';

// Exercise the shipped client orchestration without a browser or paid calls.
// Rendering is checked separately in the real browser; only DOM sinks are stubbed.
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8'))
  .replace(/^import .* from '\.\/cost-display\.mjs';\n/m,'');
const nodes=new Map(),requests=[];
let resolveJob,lookup,submit;
const context=vm.createContext({...costDisplay,crypto,console,requestAnimationFrame:()=>{},
  window:{addEventListener:()=>{}},setInterval:()=>{},
  document:{addEventListener:()=>{},getElementById:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},querySelectorAll:()=>[],hidden:false},
  fetch:async(path,options={})=>{
    requests.push({path,method:options.method||'GET',body:options.body&&JSON.parse(options.body)});
    return path==='/api/generations'?submit(JSON.parse(options.body)):lookup(path.split('/').at(-1));
  }});
vm.runInContext(source.slice(0,source.indexOf("$('logout').addEventListener")),context);
vm.runInContext('renderGrid=()=>{};renderOptions=()=>{};renderHistory=()=>{};renderLibrary=()=>{};persist=()=>{};config={};',context);
const cells=[{id:crypto.randomUUID(),model:'flux-2-klein-4b',age:4,status:'completed',metrics:{elapsedMs:12}},
  {id:crypto.randomUUID(),model:'flux-2-klein-4b',age:7,status:'failed',error:'Old failure',metrics:{httpStatus:500}}];
const run={id:crypto.randomUUID(),prompt:'Synthetic prompt',composition:'front',cells};
context.fixture=run;
const reset=()=>{requests.length=0;vm.runInContext('current=structuredClone(fixture);busy=false;',context);};
context.structuredClone=structuredClone;
const value=expression=>vm.runInContext(expression,context);
const oldID=cells[1].id;
const job=(id,status)=>Response.json({id,status,metrics:status==='completed'?{elapsedMs:20}:null,...(status==='failed'?{error:{code:'provider_unavailable',message:'Temporary failure'}}:{})});

reset();lookup=id=>job(id,'failed');submit=input=>job(input.id,'completed');
await value('retryCells(current.cells)');
let posts=requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);
assert.equal(posts[0].body.batchID,run.id);assert.notEqual(posts[0].body.id,oldID);
assert.equal(posts[0].body.age,7);assert.equal(posts[0].body.description,run.prompt);
assert.equal(value('current.cells[0].id'),cells[0].id);assert.equal(value('current.cells[1].status'),'completed');
assert.equal(value('busy'),false);

// A stale failed tile whose server job succeeded only reconciles the result.
reset();lookup=id=>job(id,'completed');await value('retryCells(current.cells)');
assert.equal(requests.filter(r=>r.method==='POST').length,0);assert.equal(value('current.cells[1].id'),oldID);

// If checking the old ID fails, preserve it rather than risking a second bill.
reset();lookup=async()=>{throw Error('Connection lost');};await value('retryCells(current.cells)');
assert.equal(requests.length,1);assert.equal(value('current.cells[1].id'),oldID);assert.equal(value('busy'),false);

// Failures before reservation (rate limits/moderation) have no account job.
reset();lookup=()=>Response.json({error:{message:'Not found'}},{status:404});await value('retryCells(current.cells)');
assert.equal(requests.filter(r=>r.method==='POST').length,1);

// Repeated clicks while reconciliation waits cannot launch duplicate work.
reset();lookup=()=>new Promise(resolve=>resolveJob=resolve);
const pending=value('retryCells(current.cells)');await value('retryCells(current.cells)');
assert.equal(value('busy'),true);assert.equal(requests.length,1);
resolveJob(job(oldID,'failed'));await pending;
assert.equal(requests.filter(r=>r.method==='POST').length,1);

// An uncertain submission checks its original ID and recovers an existing image.
reset();value("current.cells[1].status='uncertain'");lookup=id=>job(id,'completed');
await value('retryCells(current.cells)');assert.equal(requests.length,1);assert.equal(value('current.cells[1].id'),oldID);
console.log('PASS: visible retry orchestration preserves successful images, reconciles stale results, avoids duplicates on connection failures/repeated clicks, recovers pre-reservation failures and checks uncertain jobs using the original ID.');
