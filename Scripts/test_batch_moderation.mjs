import assert from 'node:assert/strict';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import {structuredComposition} from '../workers/coloring-sheets-api/src/composition.mjs';
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
const env = {OPENAI_API_KEY: 'synthetic', ACCOUNT_TOKEN_SECRET: 'synthetic-secret', FREE_DAILY_ALLOWANCE: '100', GLOBAL_DAILY_GENERATION_LIMIT: '100', MODERATION_GATEWAY_ID: 'test',
  AI: {async run(model, input) {
    inputs.push(input.state.description);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (unavailable) throw Error('private upstream text');
    const result = safeModerationResult();
    if (reject) result.answers.all_ages.noul = 0.5;
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
  const registered = await worker.fetch(new Request('https://example.test/v1/installations', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}), env);
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
  assert.ok(!JSON.stringify(logs).includes(description));
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
  assert.equal((await denied[0].json()).error.code, 'description_not_suitable');
  unavailable = true;
  const unavailableBatch = crypto.randomUUID();
  const failures = await Promise.all(['side', 'front', 'wide'].map(composition => send({...options, batchID: unavailableBatch, composition})));
  assert.deepEqual(failures.map(response => response.status), [503, 503, 503]);
  assert.equal(inputs.length, 3); assert.equal(prompts.length, beforeImages);
  // Recovering an already completed job doesn't require a fresh moderation.
  assert.equal((await send({...options, composition: 'side'}, generationIDs[0])).status, 200);
  assert.equal(inputs.length, 3);
  for (const age of [3, 6, 9, 13]) assert.ok(structuredComposition({...options, composition: 'side', age}));
  assert.equal(structuredComposition({...options, description: 'x'.repeat(500), composition: 'side'}), null);
} finally { globalThis.fetch = fetchBefore; console.info = infoBefore; }
console.log('PASS: original-only batch moderation, concurrency/restart deduplication, shared rejection/outage, binding, trusted composition, privacy and recovery; no network.');
