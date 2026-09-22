// Exercises the public Worker API with in-memory Durable Object/R2 bindings only.
import assert from 'node:assert/strict';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';

class MemoryStorage { constructor() { this.values = new Map(); } async get(k) { return this.values.get(k); } async put(k, v) { this.values.set(k, v); } }
class Accounts {
  constructor(env) { this.env = env; this.objects = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new Account({storage: new MemoryStorage()}, this.env));
    return {fetch: (request, init) => this.objects.get(id).fetch(new Request(request, init))};
  }
}
class Images {
  constructor() { this.values = new Map(); }
  async put(key, value) { this.values.set(key, value); }
  async get(key) { const value = this.values.get(key); return value && {body: new Response(value).body}; }
}
class BudgetNamespace {
  constructor(env) { this.env = env; this.objects = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new Budget({storage: new MemoryStorage()}, this.env));
    return {fetch: (request, init) => this.objects.get(id).fetch(new Request(request, init))};
  }
}
const env = {OPENAI_API_KEY: 'synthetic', ACCOUNT_TOKEN_SECRET: 'synthetic-token-secret', FREE_DAILY_ALLOWANCE: '3', GLOBAL_DAILY_GENERATION_LIMIT: '10000'};
env.ACCOUNTS = new Accounts(env); env.BUDGET = new BudgetNamespace(env); env.GENERATIONS = new Images();
const originalFetch = globalThis.fetch;
let calls = 0, forwarded;
globalThis.fetch = async (url, request) => {
  assert.equal(url, 'https://api.openai.com/v1/images/generations'); calls++;
  forwarded = JSON.parse(request.body);
  return new Response(JSON.stringify({data: [{b64_json: 'iVBORw0KGgo='}], usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3}}));
};
try {
  const registered = await worker.fetch(new Request('https://example.test/v1/installations', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}), env);
  assert.equal(registered.status, 201); const identity = await registered.json();
  assert.match(identity.accountId, /^[0-9a-f-]{36}$/); assert.ok(identity.accessToken);
  const generationId = crypto.randomUUID();
  const request = () => new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': generationId}, body: JSON.stringify({subject: 'Synthetic flower. Complexity: very simple outlines', model: 'gpt-image-2.5-flare', width: 1456, height: 1024})});
  let response = await worker.fetch(request(), env); assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(forwarded.size, '1456x1024'); assert.ok(forwarded.prompt.includes('Synthetic flower'));
  response = await worker.fetch(request(), env); assert.equal(response.status, 200); assert.equal(calls, 1, 'A repeated ID must return the stored image.');
  const access = await worker.fetch(new Request('https://example.test/v1/access', {headers: {'Authorization': 'Bearer ' + identity.accessToken}}), env);
  assert.equal((await access.json()).access.freeGenerationsRemaining, 2);
  const invalid = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'x', width: 17, height: 17})}), env);
  assert.equal(invalid.status, 400); assert.equal(calls, 1, 'Validation must run before a reservation or paid call.');
  const zeroCap = new Budget({storage: new MemoryStorage()}, {GLOBAL_DAILY_GENERATION_LIMIT: '0'});
  response = await zeroCap.fetch(new Request('https://budget/reserve', {method: 'POST', body: JSON.stringify({claim: 'test-zero'})}));
  assert.equal(response.status, 429, 'A configured zero cap must stop global reservations.');
  const malformedCap = new Budget({storage: new MemoryStorage()}, {GLOBAL_DAILY_GENERATION_LIMIT: 'not-a-number'});
  response = await malformedCap.fetch(new Request('https://budget/reserve', {method: 'POST', body: JSON.stringify({claim: 'test-malformed'})}));
  assert.equal(response.status, 503, 'A malformed cap must fail closed.');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: anonymous registration, authenticated v1 generation, quota, idempotency, and fail-closed global budget; no network.');
