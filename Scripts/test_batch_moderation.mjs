import assert from 'node:assert/strict';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import {structuredComposition} from '../workers/coloring-sheets-api/src/composition.mjs';
import {prepareGeneration, startGeneration} from '../workers/coloring-sheets-api/src/generation-start.mjs';
import {safeModerationResult} from './test_moderation.mjs';
class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({prefix}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
  async transaction(callback) { return callback(this); }
}
class Namespace {
  objects = new Map();
  constructor(type, env) { this.type = type; this.env = env; }
  idFromName(id) { return id; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new this.type({storage: new Storage()}, this.env));
    return {fetch: (url, init) => this.objects.get(id).fetch(new Request(url, init))};
  }
}
const inputs = [], prompts = [], logs = [];
let reject = false, unavailable = false;
const env = {OPENAI_API_KEY: 'synthetic', REGISTRATION_LIMITER: {limit: async () => ({success: true})}, ACCOUNT_TOKEN_SECRET: 'synthetic-secret', FREE_DAILY_ALLOWANCE: '100', GLOBAL_DAILY_GENERATION_LIMIT: '100', MODERATION_GATEWAY_ID: 'test',
  AI: {async run(model, input) {
    inputs.push(input.state.description);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (unavailable) throw Error('private upstream text');
    const result = safeModerationResult();
    if (reject) result.answers.all_ages.noul = 0.2;
    return result;
  }}};
env.ACCOUNTS = new Namespace(Account, env); env.BUDGET = new Namespace(Budget, env);
const images = new Map(); env.GENERATIONS = {async put(key, value) { images.set(key, value); }, async get(key) { return {body: new Response(images.get(key)).body}; }};
const fetchBefore = globalThis.fetch, infoBefore = console.info;
globalThis.fetch = async (url, init) => {
  prompts.push(JSON.parse(init.body).prompt);
  return Response.json({data: [{b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='}]});
};
console.info = value => logs.push(JSON.parse(value));
try {
  const registered = await worker.fetch(new Request('https://example.test/v1/installations', {method: 'POST', headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1'}, body: '{}'}), env);
  const identity = await registered.json();
  const id = crypto.randomUUID();
  const description = 'ferarri';
  const options = {batchID: id, description, age: 18, width: 1456, height: 1024, model: 'gpt-image-2.5-sunburst'};
  const send = (input, generationID = crypto.randomUUID()) => worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': generationID}, body: JSON.stringify(input)}), env);
  const generationIDs = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.all(['side', 'front', 'wide'].map((composition, i) => send({...options, composition}, generationIDs[i])));
  assert.deepEqual(results.map(response => response.status), [200, 200, 200]);
  assert.deepEqual(inputs, [description], 'One moderation call on raw text despite concurrent image requests.');
  assert.equal(prompts.length, 3); assert.equal(new Set(prompts).size, 3);
  assert.ok(prompts.every(prompt => prompt.includes('Complexity: intricate outlines')));
  assert.equal(logs.filter(log => log.event === 'description_moderation').length, 1);
  assert.deepEqual(logs.find(log => log.event === 'description_moderation').scores,
    Object.fromEntries(Object.entries(safeModerationResult().answers).map(([name, answer]) => [name, answer.noul])));
  assert.equal(logs.find(log => log.batchID === id).description, undefined);
  const object = env.ACCOUNTS.objects.get(identity.accountId);
  assert.ok(!JSON.stringify([...object.state.storage.values]).includes(description));
  // Recreating the account object simulates eviction/restart. Its cached
  // decision remains bound to the description, and never stores the text.
  env.ACCOUNTS.objects.set(identity.accountId, new Account(object.state, env));
  assert.equal((await send({...options, composition: 'side'})).status, 200);
  assert.equal(inputs.length, 1);
  assert.equal((await send({...options, description: 'different', composition: 'side'})).status, 409);
  assert.equal(inputs.length, 1);
  assert.equal((await send({...options, composition: 'ignore safety'})).status, 400);
  assert.equal((await send({...options, composition: 'side', subject: 'injected'})).status, 400);
  assert.equal((await send({...options, composition: 'side', age: 19})).status, 400);
  reject = true;
  const rejectedBatch = crypto.randomUUID(), beforeImages = prompts.length;
  const denied = await Promise.all(['side', 'front', 'wide'].map(composition => send({...options, batchID: rejectedBatch, composition})));
  assert.deepEqual(denied.map(response => response.status), [400, 400, 400]);
  assert.equal(inputs.length, 2); assert.equal(prompts.length, beforeImages);
  const deniedBodies = await Promise.all(denied.map(response => response.json()));
  assert.ok(deniedBodies.every(body => body.error.code === 'description_not_suitable'));
  assert.ok(deniedBodies.every(body => body.error.message === deniedBodies[0].error.message));
  assert.ok(deniedBodies.every(body => body.error.reasonCodes.join(',') === 'uncertain'));
  const rejectionAudit = logs.find(log => log.batchID === rejectedBatch && log.event === 'description_moderation');
  assert.equal(rejectionAudit.gateway, 'test');
  assert.deepEqual(rejectionAudit.reasonCodes, ['uncertain']);
  assert.equal(logs.filter(log => log.batchID === rejectedBatch && log.event === 'moderation_gate').length, 3);
  assert.equal(logs.find(log => log.batchID === rejectedBatch).scores.all_ages, 0.2);
  assert.equal(logs.find(log => log.batchID === rejectedBatch).description, undefined);
  assert.ok(!JSON.stringify([...object.state.storage.values]).includes('scores'));
  unavailable = true;
  const unavailableBatch = crypto.randomUUID();
  const failures = await Promise.all(['side', 'front', 'wide'].map(composition => send({...options, batchID: unavailableBatch, composition})));
  assert.deepEqual(failures.map(response => response.status), [503, 503, 503]);
  assert.equal(inputs.length, 3); assert.equal(prompts.length, beforeImages);
  assert.equal(logs.find(log => log.batchID === unavailableBatch && log.event === 'description_moderation').failure, 'upstream');
  assert.ok(!Object.hasOwn(logs.find(log => log.batchID === unavailableBatch), 'scores'));
  assert.equal(logs.find(log => log.batchID === unavailableBatch).description, undefined);
  assert.ok(!JSON.stringify(logs).includes('private upstream text'));
  assert.ok(!JSON.stringify(logs).includes(description), 'Descriptions must never be logged.');
  // Recovering an already completed job doesn't require a fresh moderation.
  assert.equal((await send({...options, composition: 'side'}, generationIDs[0])).status, 200);
  assert.equal(inputs.length, 3);
  for (const age of [3, 6, 9, 13]) assert.ok(structuredComposition({...options, composition: 'side', age}));
  assert.equal(structuredComposition({...options, description: 'x'.repeat(501), composition: 'side'}), null);

  // The description limit is independent of age and composition instructions.
  // Exercise the public API so moderation, reservation and provider dispatch
  // cannot silently retain the old 500-character expanded-subject limit.
  reject = false; unavailable = false;
  const cases = [
    [6, 'x'.repeat(255)], [6, 'A friendly fox in a garden. '.repeat(12).trim()],
    ...[3, 6, 9, 13].map(age => [age, 'x'.repeat(500)]),
    [6, '😀'.repeat(250)],
  ];
  const compositions = ['side', 'front', 'wide', 'close', 'elevated'];
  for (const [age, longDescription] of cases) {
    const beforePrompts = prompts.length, beforeModeration = inputs.length;
    const batchID = crypto.randomUUID();
    const responses = await Promise.all(compositions.map(composition =>
      send({...options, age, batchID, description: longDescription, composition})));
    assert.deepEqual(responses.map(response => response.status), compositions.map(() => 200),
      `Every composition must accept the same ${longDescription.length}-character description at age ${age}.`);
    assert.equal(inputs.length, beforeModeration + 1);
    assert.equal(inputs.at(-1), longDescription, 'Moderation sees only the original description.');
    assert.equal(prompts.length, beforePrompts + compositions.length);
    assert.ok(prompts.slice(beforePrompts).every(prompt => prompt.includes(longDescription)), 'Never truncate user input.');
  }
  const beforeOversized = prompts.length, beforeModeration = inputs.length;
  const beforeUsage = structuredClone(await object.state.storage.get('usage'));
  for (const oversized of ['x'.repeat(501), '😀'.repeat(250) + 'x']) {
    const responses = await Promise.all(compositions.map(composition =>
      send({...options, batchID: crypto.randomUUID(), description: oversized, composition})));
    assert.ok(responses.every(response => response.status === 400));
  }
  assert.equal(prompts.length, beforeOversized);
  assert.equal(inputs.length, beforeModeration);
  assert.deepEqual(await object.state.storage.get('usage'), beforeUsage, 'Oversized input must consume no allowance.');
} finally { globalThis.fetch = fetchBefore; console.info = infoBefore; }
console.log('PASS: original-only batch moderation, concurrency/restart deduplication, shared rejection/outage, binding, trusted composition, privacy and recovery; no network.');

// Both entry points must reserve the same server-composed task, and must
// recover either historical fingerprint encoding without another paid call.
{
  const generationId=crypto.randomUUID();
  const input={description:'A friendly flower',age:7,composition:'wide',batchID:crypto.randomUUID(),model:'gpt-image-2.5-flare',width:1456,height:1024};
  const prepared=await prepareGeneration(input,generationId);
  const reservations=[];
  for(const web of [false,true]) {
    const calls=[];
    const result=await startGeneration(prepared,{
      env:{OPENAI_API_KEY:'synthetic'},queueImages:true,validateProvider:!web,fingerprintFormat:web?'hex':'base64url',
      call:async(path,value)=>{
        calls.push(path);
        if(path==='/job')return {status:404,value:{}};
        if(path==='/moderate-batch'){assert.equal(value.description,input.description);return {status:200,value:{approved:true}};}
        assert.equal(path,'/reserve');reservations.push(value);
        return {status:201,value:{job:{id:generationId,state:'processing',imageTask:value.imageTask},access:{}}};
      }
    });
    assert.equal(result.status,201);assert.deepEqual(calls,['/job','/moderate-batch','/reserve']);
  }
  assert.deepEqual(reservations[0].imageTask,reservations[1].imageTask);
  assert.match(reservations[0].imageTask.subject,/Complexity: simple clear outlines/);
  assert.match(reservations[0].imageTask.subject,/Composition preference: wide view/);
  for(const fingerprint of Object.values(prepared.fingerprints)) {
    let lookups=0;
    const result=await startGeneration(prepared,{
      env:{IMAGE_MODEL_ROUTES:'invalid json'},
      call:async(path)=>{assert.equal(path,'/job');lookups++;return {status:200,value:{job:{id:generationId,state:'completed',fingerprint},access:{}}};}
    });
    assert.equal(result.recovered,true);assert.equal(lookups,1);
  }
  let reserved=false;
  const denied=await startGeneration(prepared,{
    env:{},validateProvider:false,queueImages:true,
    beforeReserve:async()=>{reserved=true;},
    call:async(path)=>path==='/job'?{status:404,value:{}}:{status:400,value:{error:{code:'description_not_suitable',message:'Choose another description.'}}}
  });
  assert.equal(denied.value.error.code,'description_not_suitable');assert.equal(reserved,false);
  const invalid=await prepareGeneration({...input,description:'x'.repeat(501)},generationId);
  assert.equal(invalid.status,400,'The shared server enforces the original description limit.');
  const oversizedLegacy=await prepareGeneration({subject:'x'.repeat(501)},generationId);
  assert.equal(oversizedLegacy.status,400,'Legacy clients do not receive extra room for untrusted subject text.');
  console.log('PASS: app/web task parity, server-only prompt construction, legacy fingerprint recovery before configuration checks, and rejection before reservation; no network.');
}
