// Historical build 6 audit reproduction, before the billing/report race was fixed.
// It asserts the old bug and is not a regression test for current main.
// Use Scripts/test_reporting_concurrency.mjs to verify the maintained fix.
// Synthetic fixture only: no network, real users, or generation.
import assert from 'node:assert/strict';
import {Account} from '../../../workers/coloring-sheets-api/src/index.mjs';

class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async list({limit = Infinity} = {}) { return new Map([...this.values].slice(0, limit)); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async setAlarm(time) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
}
const accountId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const generationId = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const storage = new Storage(), objects = new Map();
  const bucket = {
    put: async (key, value) => objects.set(key, value),
    list: async ({prefix, limit}) => ({objects: [...objects.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(key => ({key}))}),
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }
  };
  const env = {GENERATIONS: bucket, BUDGET: {idFromName: id => id, get: () => ({fetch: async () => Response.json({deleted: true})})}};
  const account = new Account({storage}, env);
  await storage.put('account', {id: accountId, credentialId});
  await storage.put('job:' + generationId, {id: generationId, state: 'completed', objectKey: accountId + '/' + generationId + '.png', fal: {request: {model: 'coloringbook-redmond-v2'}}, metrics: {billableUnits: 1}});
  let release, began;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  // Simulate delayed billing only; the production whole-job write remains intact.
  account.recordFalUsage = async job => { began(); await held; job.metrics.costStatus = 'estimated'; };
  const request = (path, value) => account.fetch(new Request('https://synthetic' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)}));
  return {storage, objects, request, started, release};
}

const oldInfo = console.info;
console.info = () => {};
try {
  const reportCase = await fixture();
  const usage = reportCase.request('/usage', {generationId});
  await reportCase.started;
  assert.equal((await reportCase.request('/report', {generationId, reason: 'violence'})).status, 201);
  assert.equal((await reportCase.storage.get('job:' + generationId)).reported, true);
  reportCase.release();
  await usage;
  const after = await reportCase.storage.get('job:' + generationId);
  const reportRace = {reportPersisted: reportCase.objects.size === 1, reportedAfterBilling: after.reported ?? false, recoveryGateWouldPass: !after.reported};
  assert.equal(reportRace.reportedAfterBilling, false, 'Audit reproduction expects the current bug; change this assertion when fixed.');

  const deletionCase = await fixture();
  const deletionUsage = deletionCase.request('/usage', {generationId});
  await deletionCase.started;
  let deletionFinished = false;
  const deletion = deletionCase.request('/delete', {accountId, credentialId}).then(response => { deletionFinished = true; return response; });
  for (let i = 0; i < 100 && !await deletionCase.storage.get('deletion'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(await deletionCase.storage.get('deletion'));
  assert.equal(deletionFinished, false, 'Deletion must await the tracked billing operation.');
  deletionCase.release();
  const [, deleted] = await Promise.all([deletionUsage, deletion]);
  assert.equal(deleted.status, 200);
  assert.deepEqual([...deletionCase.storage.values.keys()], ['deletion']);
  console.log(JSON.stringify({reportRace, deletionRace: {waitedForBilling: true, jobResurrected: false, remainingKeys: [...deletionCase.storage.values.keys()]}}, null, 2));
} finally { console.info = oldInfo; }
