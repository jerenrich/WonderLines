import assert from 'node:assert/strict';
import {Account} from '../workers/coloring-sheets-api/src/index.mjs';
import {observeStorage, storageFailure} from '../workers/shared/operational-events.mjs';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async setAlarm() {}
  async list({prefix}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))); }
}

const errors = [], infos = [];
const originalError = console.error, originalInfo = console.info;
console.error = value => errors.push(JSON.parse(value));
console.info = value => infos.push(JSON.parse(value));
const privateText = 'PRIVATE_PROMPT_PROVIDER_MESSAGE_AND_KEY';
const failure = new Error(privateText);
const id = crypto.randomUUID(), storage = new MemoryStorage();
const env = {GENERATIONS: {async put() { throw failure; }}};
const account = new Account({storage}, env);
account.access = async () => ({});
try {
  await storage.put('account', {id: crypto.randomUUID()});
  await storage.put('job:' + id, {id, state: 'processing', subject: privateText});

  // An actual legacy image save failure is visible and preserves its exception
  // and recoverable job. No account or image-provider request is made.
  await assert.rejects(account.storeResult({generationId: id, image: btoa('image')}), error => error === failure);
  assert.deepEqual(errors.pop(), {event: 'storage_failure', operation: 'image_write', generationID: id});
  assert.equal((await storage.get('job:' + id)).state, 'processing');

  // Failure to persist the terminal job must not emit a terminal-result event.
  const originalPut = storage.put.bind(storage);
  storage.put = async () => { throw failure; };
  await assert.rejects(account.complete({generationId: id, result: {state: 'failed', message: privateText}}), error => error === failure);
  assert.deepEqual(errors.pop(), {event: 'storage_failure', operation: 'job_write', generationID: id});
  assert.equal(infos.length, 0);
  storage.put = originalPut;

  assert.equal((await account.complete({generationId: id, result: {state: 'failed', message: privateText}})).status, 200);
  assert.deepEqual(errors.pop(), {event: 'generation_result', outcome: 'failed', generationID: id});
  assert.equal((await account.complete({generationId: id, result: {state: 'failed'}})).status, 404);
  assert.equal(errors.length, 0, 'Repeated completion must not duplicate the result event.');

  const completedID = crypto.randomUUID();
  await storage.put('job:' + completedID, {id: completedID, state: 'processing'});
  assert.equal((await account.complete({generationId: completedID, result: {state: 'completed'}})).status, 200);
  assert.deepEqual(infos.pop(), {event: 'generation_result', outcome: 'completed', generationID: completedID});

  // Queued persistence failures remain visible even when Promise.allSettled
  // catches the original exception before the alarm throws its fixed error.
  await storage.put('fal:' + id, id);
  account.advanceFal = async () => { throw failure; };
  await assert.rejects(account.runAlarm(), /Queued generation persistence failed/);
  assert.deepEqual(errors.pop(), {event: 'storage_failure', operation: 'queue_persistence'});

  assert.equal(await observeStorage('image_read', id, async () => 42), 42);
  storageFailure(privateText, privateText);
  assert.deepEqual(errors.pop(), {event: 'storage_failure', operation: 'unknown'});
  assert.ok(!JSON.stringify([...errors, ...infos]).includes(privateText));
} finally { console.error = originalError; console.info = originalInfo; }
console.log('PASS: failed R2 saves, terminal job persistence, queued persistence, result deduplication and private-data exclusion; no network.');
