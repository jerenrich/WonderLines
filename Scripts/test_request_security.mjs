// Public API abuse regressions with in-memory bindings and no network access.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import lab from '../workers/moderation-lab/src/index.mjs';

class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
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
// Simulate the configured edge binding; the global cap uses the actual Budget DO.
const config = JSON.parse(readFileSync(new URL('../workers/coloring-sheets-api/wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const rate = config.ratelimits.find(binding => binding.name === 'REGISTRATION_LIMITER').simple;
assert.deepEqual(rate, {limit: 5, period: 60});
class Limiter {
  now = 0;
  counts = new Map();
  async limit({key}) {
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, 'Only an opaque HMAC reaches the binding');
    const bucket = key + ':' + Math.floor(this.now / (rate.period * 1000));
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);
    return {success: count <= rate.limit};
  }
}
function environment(extra = {}) {
  const env = {ACCOUNT_TOKEN_SECRET: 'synthetic-secret', REGISTRATION_LIMITER: new Limiter(),
    APP_ATTEST_APP_ID: 'ABCDEFGHIJ.com.jordan.family.ColoringSheets', APP_ATTEST_ENVIRONMENT: 'production', ...extra};
  env.ACCOUNTS = new Namespace(Account, env);
  env.BUDGET = new Namespace(Budget, env);
  return env;
}
const request = (path, body = '{}', headers = {}) => new Request('https://local.test' + path, {
  method: 'POST', headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers}, body,
  ...(body instanceof ReadableStream ? {duplex: 'half'} : {})
});
const register = (env, address = '192.0.2.1', headers = {}) => worker.fetch(request('/v1/installations', '{}', {'CF-Connecting-IP': address, ...headers}), env);
function upload(total, chunkSize = 1024) {
  const progress = {bytes: 0, cancelled: false};
  progress.body = new ReadableStream({
    pull(controller) {
      if (progress.bytes === total) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(chunkSize, total - progress.bytes)).fill(32);
      progress.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { progress.cancelled = true; }
  }, {highWaterMark: 0});
  return progress;
}
const network = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected network request'); };
try {
  const env = environment();
  let first;
  for (let i = 0; i < 5; i++) {
    const response = await register(env);
    assert.equal(response.status, 201);
    first ??= await response.json();
  }
  const denied = await register(env, '192.0.2.1', {'X-Forwarded-For': '203.0.113.2', 'X-Real-IP': '203.0.113.3'});
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal(env.ACCOUNTS.objects.size, 5, 'Throttled requests create no accounts');
  const ledger = env.BUDGET.objects.get('daily-generation-budget');
  assert.equal((await ledger.state.storage.get('registrations')).used, 5);
  assert.equal((await register(env, '2001:db8::1')).status, 201, 'Another address has a separate limit');
  env.REGISTRATION_LIMITER.now += 60000;
  assert.equal((await register(env)).status, 201, 'Registrations resume after the burst window');
  assert.ok(!JSON.stringify([...ledger.state.storage.values]).includes('192.0.2.1'));

  for (const overrides of [
    {REGISTRATION_LIMITER: undefined},
    {REGISTRATION_LIMITER: {async limit() { throw Error('Unavailable'); }}},
    {BUDGET: undefined}
  ]) {
    const broken = Object.assign(environment(), overrides);
    assert.equal((await register(broken)).status, 503);
    assert.equal(broken.ACCOUNTS.objects.size, 0);
  }
  const noAddress = request('/v1/installations');
  noAddress.headers.delete('CF-Connecting-IP');
  assert.equal((await worker.fetch(noAddress, environment())).status, 503);

  // Different edge locations/addresses cannot exceed the serialized global cap.
  const capped = environment({GLOBAL_DAILY_REGISTRATION_LIMIT: '3'});
  const concurrent = await Promise.all(Array.from({length: 12}, (_, i) => register(capped, '192.0.2.' + (i + 1))));
  assert.equal(concurrent.filter(r => r.status === 201).length, 3);
  assert.equal(concurrent.filter(r => r.status === 429).length, 9);
  assert.equal(capped.ACCOUNTS.objects.size, 3);
  assert.ok(Number(concurrent.find(r => r.status === 429).headers.get('Retry-After')) > 0);
  const previous = capped.BUDGET.objects.get('daily-generation-budget');
  capped.BUDGET.objects.set('daily-generation-budget', new Budget(previous.state, capped));
  assert.equal((await register(capped, '198.51.100.1')).status, 429, 'The cap survives object restarts');
  await previous.state.storage.put('registrations', {day: '2000-01-01', used: 3});
  assert.equal((await register(capped, '198.51.100.2')).status, 201, 'A new UTC day restores registration capacity');
  for (const limit of ['0', '-1', 'invalid', '100001']) {
    const invalid = environment({GLOBAL_DAILY_REGISTRATION_LIMIT: limit});
    assert.equal((await register(invalid)).status, limit === '0' ? 429 : 503);
    assert.equal(invalid.ACCOUNTS.objects.size, 0);
  }
  const defaultCap = environment();
  const defaultLedger = defaultCap.BUDGET.get(defaultCap.BUDGET.idFromName('daily-generation-budget'));
  await defaultCap.BUDGET.objects.get('daily-generation-budget').state.storage.put('registrations', {day: new Date().toISOString().slice(0, 10), used: 1000});
  assert.equal((await defaultLedger.fetch('https://budget/register', {method: 'POST', body: '{}'})).status, 429);

  // Renewal and existing accounts remain usable when registration is closed.
  env.GLOBAL_DAILY_REGISTRATION_LIMIT = '0';
  const auth = {Authorization: 'Bearer ' + first.accessToken};
  assert.equal((await worker.fetch(request('/v1/installations/renew', '{}', auth), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://local.test/v1/access', {headers: auth}), env)).status, 200);

  for (const value of ['null', '[]', 'true', '{"unexpected":1}', '{']) {
    const invalid = environment();
    assert.equal((await worker.fetch(request('/v1/installations', value), invalid)).status, 400);
    assert.equal(invalid.ACCOUNTS.objects.size, 0);
    assert.equal(invalid.BUDGET.objects.size, 0, 'Malformed input does not reserve global capacity');
  }
  assert.equal((await worker.fetch(request('/v1/installations', '{}' + ' '.repeat(4094)), environment())).status, 201);
  assert.equal((await worker.fetch(request('/v1/installations', JSON.stringify({text: '🐈'.repeat(1100)})), environment())).status, 413, 'Size limits count bytes rather than JS characters');

  const identityEnv = environment();
  const identity = await (await register(identityEnv)).json();
  const identityAuth = {Authorization: 'Bearer ' + identity.accessToken};
  for (const [path, max, headers] of [
    ['/v1/installations', 4096, {}],
    ['/v1/installations/renew', 4096, identityAuth],
    ['/v1/app-attest/challenge', 4096, identityAuth],
    ['/v1/app-attest/attest', 16384, identityAuth],
    ['/v1/generations', 4096, identityAuth],
    ['/v1/generations', 4096, {...identityAuth, 'X-App-Attest-Assertion': 'synthetic'}],
    ['/v1/generations/' + crypto.randomUUID() + '/report', 4096, identityAuth]
  ]) {
    const stream = upload(1024 * 1024);
    const response = await worker.fetch(request(path, stream.body, headers), identityEnv);
    assert.equal(response.status, 413, path);
    assert.equal((await response.json()).error.code, 'request_too_large');
    assert.equal(stream.bytes, max + 1024, 'Stop on the first chunk over the limit');
    assert.equal(stream.cancelled, true, 'Cancel the remaining upload');
  }
  for (const declared of ['1048576', '1']) {
    const stream = upload(1024 * 1024);
    assert.equal((await worker.fetch(request('/v1/installations', stream.body, {'Content-Length': declared}), environment())).status, 413);
    assert.equal(stream.bytes, declared === '1' ? 5120 : 0);
    assert.equal(stream.cancelled, true);
  }
  const unicode = new TextEncoder().encode(JSON.stringify({text: '🐈'}));
  let offset = 0;
  const splitUTF8 = new ReadableStream({pull(controller) {
    if (offset === unicode.length) controller.close(); else controller.enqueue(unicode.slice(offset, ++offset));
  }}, {highWaterMark: 0});
  assert.equal((await worker.fetch(request('/v1/installations/renew', splitUTF8, identityAuth), identityEnv)).status, 200, 'UTF-8 characters can span chunks');

  // The authenticated lab shares the bounded reader and its larger 16 KB limit.
  const labStream = upload(1024 * 1024);
  const labResponse = await lab.fetch(new Request('https://lab.test/api/compare', {method: 'POST',
    headers: {Authorization: 'Bearer synthetic'}, body: labStream.body, duplex: 'half'}), {LAB_ACCESS_KEY: 'synthetic'});
  assert.equal(labResponse.status, 413);
  assert.equal(labStream.bytes, 17408);
  assert.equal(labStream.cancelled, true);
} finally { globalThis.fetch = network; }
console.log('PASS: registration throttling, opaque address keys, global concurrency/restart/day limits, fail-closed protection, renewal compatibility, and streaming byte limits/cancellation across API and lab; no network.');
