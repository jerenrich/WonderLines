import assert from 'node:assert/strict';
import {SignJWT} from 'jose';
import worker from '../src/index.mjs';
import {service, actor} from '../../../Scripts/fixtures/safety-service.mjs';
const test = service(), identity = await test.register();
const origin = 'https://admin.example', env = {...test.env, MODEL_ADMIN_ORIGIN: origin, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-google-secret', MODEL_ADMIN_SESSION_SECRET: 'synthetic-session-secret-longer-than-32-characters'};
const token = email => new SignJWT({purpose: 'session', email}).setProtectedHeader({alg: 'HS256'}).setIssuer('wonderlines-model-admin')
  .setAudience(env.GOOGLE_CLIENT_ID).setSubject('verified-http-operator').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(env.MODEL_ADMIN_SESSION_SECRET));
const cookie = '__Host-wonderlines_admin=' + await token(actor.email);
const http = (path, method = 'GET', input, headers = {}) => worker.fetch(new Request(origin + '/api/admin' + path, {
  method, headers: {Cookie: cookie, ...(method === 'POST' ? {Origin: origin, 'Content-Type': 'application/json'} : {}), ...headers},
  ...(input !== undefined ? {body: typeof input === 'string' ? input : JSON.stringify(input)} : {})}), env);
const path = '/accounts/' + identity.accountId;
let response = await http(path); assert.equal(response.status, 200); let current = await response.json();
assert.equal(current.accountId, identity.accountId); assert.equal(current.version, 0); assert.equal(response.headers.get('Cache-Control'), 'no-store');
const operation = {action: 'suspend', durationHours: 24, reason: 'Reviewed repeated violations', requestId: crypto.randomUUID(), expectedVersion: current.version,
  actor: {id: 'forged-browser-identity', email: 'someone@example.com'}};
assert.equal((await http(path + '/suspension', 'POST', operation, {Origin: 'https://evil.example'})).status, 403);
assert.equal((await http(path, 'GET', undefined, {Cookie: ''})).status, 401);
assert.equal((await http('/suspensions', 'GET', undefined, {Cookie: '__Host-wonderlines_admin=' + await token('other@example.com')})).status, 401);
assert.equal((await http(path + '/suspension', 'POST', '{')).status, 400);
assert.equal((await http(path + '/suspension', 'POST', 'x'.repeat(4100))).status, 413);
assert.equal((await http(path + '/suspension', 'POST', operation, {'Content-Type': 'text/plain'})).status, 400);
for (const overrides of [{reason: ''}, {reason: 'x'.repeat(301)}, {reason: 'hidden\u0000'}, {durationHours: -1}, {durationHours: '24'}, {requestId: 'invalid'}, {expectedVersion: -1}, {action: 'delete'}]) {
  assert.equal((await http(path + '/suspension', 'POST', {...operation, ...overrides})).status, 400);
}
response = await http(path + '/suspension', 'POST', operation); assert.equal(response.status, 200); current = await response.json();
assert.equal(current.suspension.actor.id, 'verified-http-operator', 'Attribution comes from the verified session.');
assert.equal(current.suspension.actor.email, actor.email);
assert.equal((await http(path + '/suspension', 'POST', operation)).status, 200, 'A repeated command is idempotent.');
assert.equal((await http(path + '/suspension', 'POST', {...operation, requestId: crypto.randomUUID()})).status, 409);
response = await http('/suspensions'); const page = await response.json(); assert.equal(page.accounts.length, 1); assert.equal(page.accounts[0].accountId, identity.accountId);
assert.equal((await http('/suspensions?cursor=not-a-uuid')).status, 400);
assert.equal((await http('/accounts/' + crypto.randomUUID())).status, 404, 'Lookup never creates an account record.');
assert.equal((await http(path + '/suspension', 'GET')).status, 404);
assert.equal((await http(path, 'POST', {})).status, 404);
response = await http(path + '/suspension', 'POST', {...operation, action: 'reinstate', requestId: crypto.randomUUID(), expectedVersion: current.version});
assert.equal(response.status, 200); assert.equal((await response.json()).rejectionCount, 0);
assert.equal((await (await http('/suspensions')).json()).accounts.length, 0);
const account = test.env.ACCOUNTS.objects.get(identity.accountId);
assert.equal(await account.state.storage.get('account-safety').then(value => value.history.length), 2);
// Pagination must progress even when every record on a page has expired.
const directory = test.env.BUDGET.objects.get('daily-generation-budget');
for (let i = 0; i < 60; i++) await directory.state.storage.put('suspension:' + '00000000-0000-0000-0000-' + String(i).padStart(12, '0'),
  {accountId: '00000000-0000-0000-0000-' + String(i).padStart(12, '0'), version: 1, updatedAt: Date.now(), suspension: null});
const emptyPage = await (await http('/suspensions')).json(); assert.equal(emptyPage.accounts.length, 0); assert.ok(emptyPage.nextCursor);
assert.equal((await http('/suspensions?cursor=' + emptyPage.nextCursor)).status, 200);
assert.ok(!JSON.stringify(current).includes(env.MODEL_ADMIN_SESSION_SECRET));
console.log('PASS: suspension admin authentication, CSRF, validation, verified operator attribution, idempotency, stale versions, account lookup, active listing and empty-page pagination; no network.');
