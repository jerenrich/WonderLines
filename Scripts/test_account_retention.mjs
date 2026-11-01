// Offline tests for 180-day inactivity deletion and expired-account renewal.
import assert from 'node:assert/strict';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import {INACTIVITY_MS, recordActivity, inactivityDue, ensureActivityRecord, retentionBackfillPage} from '../workers/coloring-sheets-api/src/account-retention.mjs';
import {safeModerationResult} from './test_moderation.mjs';

const DAY = 86400000;
class Storage {
  values = new Map(); alarm = null;
  async get(k) { return structuredClone(this.values.get(k)); }
  async put(k, v) { this.values.set(k, structuredClone(v)); }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(fn) { return fn(this); }
  async list({prefix = '', limit = Infinity, startAfter} = {}) {
    const keys = [...this.values.keys()].filter(k => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort().slice(0, limit);
    return new Map(keys.map(k => [k, structuredClone(this.values.get(k))]));
  }
}

// Module behaviour with an explicit clock.
{
  const storage = new Storage(), start = 1_800_000_000_000;
  await recordActivity(storage, start);
  assert.equal((await storage.get('activity')).lastActiveAt, start);
  assert.equal(storage.alarm, start + INACTIVITY_MS);
  await recordActivity(storage, start + DAY - 1);
  assert.equal((await storage.get('activity')).lastActiveAt, start, 'Activity is written at most daily.');
  await recordActivity(storage, start + DAY);
  assert.equal((await storage.get('activity')).lastActiveAt, start + DAY);
  storage.alarm = start + 5000;
  await recordActivity(storage, start + 3 * DAY);
  assert.equal(storage.alarm, start + 5000, 'An earlier alarm for queued work is kept.');
  storage.alarm = null;
  assert.equal(await inactivityDue(storage, start + 3 * DAY + INACTIVITY_MS - 1), false);
  assert.equal(storage.alarm, start + 3 * DAY + INACTIVITY_MS, 'A consumed alarm is re-armed for the due time.');
  assert.equal(await inactivityDue(storage, start + 3 * DAY + INACTIVITY_MS), true);

  const legacy = new Storage();
  assert.equal(await ensureActivityRecord(legacy, start), true);
  assert.equal(await ensureActivityRecord(legacy, start + DAY), false);
  assert.equal(await inactivityDue(legacy, start + DAY), false, 'Older accounts start their window, never expire at once.');

  const budget = new Storage();
  for (const [account, generation] of [['a', 1], ['a', 2], ['b', 1], ['c', 1]]) await budget.put(`claim:${account}:${generation}`, true);
  await budget.put('usage', {day: '2026-11-01', used: 4});
  const first = await retentionBackfillPage(budget, 2), second = await retentionBackfillPage(budget, 2), third = await retentionBackfillPage(budget, 2);
  assert.deepEqual(first, {accountIds: ['a'], complete: false});
  assert.deepEqual(second, {accountIds: ['b', 'c'], complete: false});
  assert.deepEqual(third, {accountIds: [], complete: true});
  assert.deepEqual(await retentionBackfillPage(budget, 2), {accountIds: [], complete: true}, 'Backfill runs once.');
}

// Account Durable Object and public API.
class Namespace {
  objects = new Map();
  constructor(Type, env) { this.Type = Type; this.env = env; }
  idFromName(id) { return id; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new this.Type({storage: new Storage()}, this.env));
    return {fetch: (url, init) => this.objects.get(id).fetch(new Request(url, init))};
  }
}
class Bucket {
  values = new Map();
  async put(key, value) { this.values.set(key, value); }
  async list({prefix, limit}) { return {objects: [...this.values.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(key => ({key}))}; }
  async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) this.values.delete(k); }
}
const env = {REGISTRATION_LIMITER: {limit: async () => ({success: true})}, ACCOUNT_TOKEN_SECRET: 'synthetic-secret', OPENAI_API_KEY: 'synthetic',
  FREE_DAILY_ALLOWANCE: '100', GLOBAL_DAILY_GENERATION_LIMIT: '1000', MODERATION_GATEWAY_ID: 'synthetic', AI: {run: async () => safeModerationResult()}};
env.ACCOUNTS = new Namespace(Account, env); env.BUDGET = new Namespace(Budget, env); env.GENERATIONS = new Bucket();
const realInfo = console.info, logs = [];
console.info = value => logs.push(value);
const api = (path, who, method = 'GET', value) => worker.fetch(new Request('https://test' + path, {method,
  headers: {...(who ? {Authorization: 'Bearer ' + who.accessToken} : {}), ...(value ? {'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1'} : {})},
  ...(value ? {body: JSON.stringify(value)} : {})}), env);
const register = async () => await (await api('/v1/installations', null, 'POST', {})).json();
const object = who => env.ACCOUNTS.objects.get(who.accountId);
const age = async (who, days) => object(who).state.storage.put('activity', {lastActiveAt: Date.now() - days * DAY});
try {
  const active = await register(), idle = await register(), comparison = await register();
  const stored = await object(active).state.storage.get('activity');
  assert.ok(Math.abs(stored.lastActiveAt - Date.now()) < 5000, 'Registration starts the activity window.');
  assert.ok(Math.abs(object(active).state.storage.alarm - (stored.lastActiveAt + INACTIVITY_MS)) < 5000);

  await age(active, 2);
  assert.equal((await api('/v1/access', active)).status, 200);
  assert.ok(Date.now() - (await object(active).state.storage.get('activity')).lastActiveAt < 5000, 'Authenticated requests count as activity.');

  await age(active, 179); object(active).state.storage.alarm = null;
  await object(active).alarm();
  assert.ok(await object(active).state.storage.get('account'), 'Accounts inside the window are kept.');
  assert.ok(object(active).state.storage.alarm > Date.now(), 'The retention alarm is re-armed.');

  env.GENERATIONS.values.set(idle.accountId + '/' + crypto.randomUUID() + '.png', 'synthetic');
  env.GENERATIONS.values.set('reports/' + idle.accountId + '/' + crypto.randomUUID() + '.json', 'synthetic');
  await age(idle, 181);
  await object(idle).alarm();
  assert.equal(await object(idle).state.storage.get('account'), undefined, 'Inactive accounts are deleted.');
  assert.equal(await object(idle).state.storage.get('activity'), undefined);
  assert.equal((await object(idle).state.storage.get('deletion')).complete, true);
  assert.equal([...env.GENERATIONS.values.keys()].filter(k => k.includes(idle.accountId)).length, 0, 'Stored images and reports are deleted.');
  assert.ok(logs.some(line => JSON.parse(line).event === 'account_inactivity_deletion'));
  assert.ok(!logs.some(line => line.includes(idle.accountId)), 'Logs do not name the account.');

  const renewed = await api('/v1/installations/renew', idle, 'POST', {});
  assert.equal(renewed.status, 410);
  assert.equal((await renewed.json()).error.code, 'account_expired', 'The app is told to start a new account.');
  await object(idle).state.storage.delete('deletion');
  const forgotten = await api('/v1/installations/renew', idle, 'POST', {});
  assert.equal(forgotten.status, 410, 'Accounts whose deletion marker has lapsed are also expired.');
  assert.equal((await api('/v1/installations/renew', active, 'POST', {})).status, 200, 'Live accounts still renew.');

  env.COMPARISON_ACCOUNT_ID = comparison.accountId;
  await age(comparison, 400);
  await object(comparison).alarm();
  assert.ok(await object(comparison).state.storage.get('account'), 'The comparison service account is exempt.');
  delete env.COMPARISON_ACCOUNT_ID;

  // Backfill gives an older account (no activity record) a window via the Budget claims.
  await object(active).state.storage.delete('activity');
  const budget = env.BUDGET.get('daily-generation-budget');
  await env.BUDGET.objects.get('daily-generation-budget').state.storage.put('claim:' + active.accountId + ':' + crypto.randomUUID(), true);
  const page = await (await budget.fetch('https://budget/retention-accounts', {method: 'POST', body: '{}'})).json();
  assert.deepEqual(page.accountIds, [active.accountId]);
  const init = await (await env.ACCOUNTS.get(active.accountId).fetch('https://account/retention-init', {method: 'POST', body: '{}'})).json();
  assert.equal(init.started, true);
  assert.ok(await object(active).state.storage.get('activity'));
} finally { console.info = realInfo; }
console.log('PASS: 180-day inactivity window, daily activity writes, alarm re-arming, deletion of account, images and reports, expired-account renewal, comparison exemption and one-time backfill; no network.');
