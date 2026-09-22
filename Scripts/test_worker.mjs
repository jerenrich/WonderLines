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
  assert.equal(forwarded.model, 'gpt-image-2.5-flare');
  assert.equal(forwarded.size, '1456x1024'); assert.ok(forwarded.prompt.includes('Synthetic flower'));
  response = await worker.fetch(request(), env); assert.equal(response.status, 200); assert.equal(calls, 1, 'A repeated ID must return the stored image.');
  const sunburst = new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'Synthetic flower', model: 'gpt-image-2.5-sunburst', width: 1456, height: 1024})});
  response = await worker.fetch(sunburst, env); assert.equal(response.status, 200); assert.equal(calls, 2);
  assert.equal(forwarded.model, 'gpt-image-2.5-sunburst', 'The selected model must reach OpenAI.');
  const access = await worker.fetch(new Request('https://example.test/v1/access', {headers: {'Authorization': 'Bearer ' + identity.accessToken}}), env);
  assert.equal((await access.json()).access.freeGenerationsRemaining, 1);
  const invalid = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'x', width: 17, height: 17})}), env);
  assert.equal(invalid.status, 400); assert.equal(calls, 2, 'Validation must run before a reservation or paid call.');
  const invalidModel = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'Synthetic flower', model: 'unsupported-model'})}), env);
  assert.equal(invalidModel.status, 400); assert.equal(calls, 2, 'Unsupported models must be rejected before a paid call.');
  const zeroCap = new Budget({storage: new MemoryStorage()}, {GLOBAL_DAILY_GENERATION_LIMIT: '0'});
  response = await zeroCap.fetch(new Request('https://budget/reserve', {method: 'POST', body: JSON.stringify({claim: 'test-zero'})}));
  assert.equal(response.status, 429, 'A configured zero cap must stop global reservations.');
  const malformedCap = new Budget({storage: new MemoryStorage()}, {GLOBAL_DAILY_GENERATION_LIMIT: 'not-a-number'});
  response = await malformedCap.fetch(new Request('https://budget/reserve', {method: 'POST', body: JSON.stringify({claim: 'test-malformed'})}));
  assert.equal(response.status, 503, 'A malformed cap must fail closed.');
  // At the new allowance boundary, a concurrent batch may reserve only the two
  // remaining images. The remote budget call must not permit lost usage updates.
  const largeEnv = {...env, FREE_DAILY_ALLOWANCE: '1000'};
  largeEnv.ACCOUNTS = new Accounts(largeEnv); largeEnv.BUDGET = new BudgetNamespace(largeEnv);
  const accountID = crypto.randomUUID(), largeStub = largeEnv.ACCOUNTS.get(accountID);
  response = await largeStub.fetch('https://account/initialize', {method: 'POST', body: JSON.stringify({accountId: accountID})});
  assert.equal((await response.json()).access.freeGenerationsRemaining, 1000);
  const account = largeEnv.ACCOUNTS.objects.get(accountID);
  await account.state.storage.put('usage', {day: new Date().toISOString().slice(0, 10), used: 998});
  const reserve = generationId => largeStub.fetch('https://account/reserve', {method: 'POST', body: JSON.stringify({generationId, fingerprint: 'synthetic'})});
  const ids = Array.from({length: 5}, () => crypto.randomUUID());
  const reservations = await Promise.all(ids.map(reserve));
  assert.deepEqual(reservations.map(r => r.status), [201, 201, 429, 429, 429]);
  assert.equal((await account.access()).freeGenerationsRemaining, 0);
  assert.equal((await reserve(ids[0])).status, 200, 'A repeated ID must not consume another allowance.');
  assert.equal((await account.state.storage.get('usage')).used, 1000);
  // An in-flight duplicate recovers the existing job, without calling OpenAI twice.
  let releaseUpstream;
  const upstreamWaiting = new Promise(resolve => { releaseUpstream = resolve; });
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let concurrentCalls = 0;
  globalThis.fetch = async () => {
    concurrentCalls++; notifyStarted(); await upstreamWaiting;
    return new Response(JSON.stringify({data: [{b64_json: 'iVBORw0KGgo='}]}));
  };
  const duplicateID = crypto.randomUUID();
  const duplicateRequest = () => new Request('https://example.test/v1/generations', {method: 'POST', headers: {
    'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': duplicateID
  }, body: JSON.stringify({subject: 'Synthetic flower'})});
  const first = worker.fetch(duplicateRequest(), env);
  await started;
  response = await worker.fetch(duplicateRequest(), env);
  assert.equal(response.status, 202);
  assert.equal(concurrentCalls, 1);
  releaseUpstream();
  assert.equal((await first).status, 200);
  // Expiry must not create a new account or strand its credits and saved jobs.
  const storedAccount = env.ACCOUNTS.objects.get(identity.accountId);
  await storedAccount.state.storage.put('credits', 7);
  const beforeRenewal = await storedAccount.access();
  const accountCount = env.ACCOUNTS.objects.size;
  const originalNow = Date.now;
  const renewRequest = credential => new Request('https://example.test/v1/installations/renew', {
    method: 'POST', headers: {'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'}, body: '{}'
  });
  try {
    Date.now = () => originalNow() + 31 * 24 * 60 * 60 * 1000;
    response = await worker.fetch(request(), env);
    assert.equal(response.status, 401, 'Expired credentials cannot generate images.');
    response = await worker.fetch(renewRequest(identity.accessToken), env);
    assert.equal(response.status, 200);
    const renewed = await response.json();
    assert.equal(renewed.accountId, identity.accountId);
    assert.ok(renewed.expiresAt > Date.now() / 1000);
    assert.deepEqual(renewed.access, beforeRenewal);
    assert.equal(env.ACCOUNTS.objects.size, accountCount, 'Renewal cannot initialize another account.');
    response = await worker.fetch(new Request('https://example.test/v1/generations/' + generationId, {
      headers: {'Authorization': 'Bearer ' + renewed.accessToken}
    }), env);
    assert.equal(response.status, 200, 'Renewed identity can recover its old images.');
    assert.equal(concurrentCalls, 1, 'Renewal and recovery do not call the image provider.');
    assert.equal((await worker.fetch(renewRequest(identity.accessToken + 'x'), env)).status, 401);
    const savedAccount = await storedAccount.state.storage.get('account');
    await storedAccount.state.storage.put('account', {...savedAccount, credentialId: crypto.randomUUID()});
    assert.equal((await worker.fetch(renewRequest(identity.accessToken), env)).status, 401,
                 'Expired credentials still require the current, unrevoked credential ID.');
    await storedAccount.state.storage.put('account', savedAccount);
  } finally { Date.now = originalNow; }
  env.GLOBAL_DAILY_GENERATION_LIMIT = '0';
  env.BUDGET = new BudgetNamespace(env);
  response = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {
    'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()
  }, body: JSON.stringify({subject: 'Synthetic flower'})}), env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'service_budget_exhausted', 'Keep service and personal limits distinct.');
  assert.deepEqual(await storedAccount.access(), beforeRenewal, 'A full service budget cannot spend account credits.');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: registration/renewal, expiry/revocation, retained accounts and jobs, generation, concurrent reservations, idempotency, and service/personal budgets; no network.');
