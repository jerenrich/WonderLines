import assert from 'node:assert/strict';
import {advancePolicy, failuresFromTail, BATCH_MS} from '../workers/monitoring/src/policy.mjs';
import monitor, {AlertState} from '../workers/monitoring/src/index.mjs';
const start = 1_000_000;
const trace = (event, at = start, scriptName = 'coloring-sheets-api') => ({scriptName,
  event: {request: {headers: {authorization: 'PRIVATE'}}},
  logs: [{timestamp: at, message: [JSON.stringify({...event, prompt: 'PRIVATE', generationID: 'PRIVATE'})]}]});
const raw = failuresFromTail([
  trace({event: 'generation_result', outcome: 'failed'}),
  trace({event: 'storage_failure'}),
  trace({event: 'description_moderation', outcome: 'description_not_suitable'}),
  trace({event: 'description_moderation_complete', degraded: true}),
  trace({event: 'generation_result', outcome: 'failed'}, start, 'unrelated-worker'),
  trace({event: 'storage_failure'}, start - 300_001),
], start);
assert.deepEqual(raw, [{category: 'image', at: start}, {category: 'storage', at: start}, {category: 'moderation', at: start}]);
assert.ok(!JSON.stringify(raw).includes('PRIVATE'));

// The review-session failure was one eight-second timeout shared by three
// generation requests. It must qualify without waiting for a two-minute streak.
const reviewFailure = failuresFromTail([
  trace({event: 'description_moderation', outcome: 'moderation_unavailable', failure: 'timeout', elapsedMs: 8000}),
  ...Array.from({length: 3}, () => trace({event: 'comparison_start_failed', status: 503, errorCode: 'moderation_unavailable'})),
], start);
assert.ok(reviewFailure.every(failure => failure.category === 'moderation' && failure.immediate));
const reviewAlert = advancePolicy(null, reviewFailure, start);
assert.deepEqual(reviewAlert.batch.map(event => event.category), ['moderation']);
assert.equal(reviewAlert.batch[0].failureSpanSeconds, 0);
assert.equal(advancePolicy(reviewAlert.state, reviewFailure, start).batch.length, 0);
assert.equal(advancePolicy(reviewAlert.state, [{category: 'moderation', at: start + 1000, immediate: true}], start + 1000).batch.length, 0);

// Single-approval logs use availability=partial after the second
// provider fails. This is degraded service, with the ordinary grace period.
const partial = failuresFromTail([trace({event: 'description_moderation_complete', outcome: 'approved', availability: 'partial'})], start);
assert.deepEqual(partial, [{category: 'moderation', at: start}]);
assert.equal(advancePolicy(null, partial, start).batch.length, 0);
assert.deepEqual(failuresFromTail([trace({event: 'description_moderation_complete', outcome: 'description_not_suitable', availability: 'both_available'})], start), []);

let {state, batch} = advancePolicy(null, raw, start);
assert.equal(batch.length, 0);
({state, batch} = advancePolicy(state, [], start + 120_001));
assert.equal(batch.length, 0, 'an isolated error must never age into an alert');
assert.deepEqual(state.streaks, {});

state = null;
for (const offset of [0, 60_000, 119_999]) {
  ({state, batch} = advancePolicy(state, ['image', 'storage', 'moderation'].map(category => ({category, at: start + offset})), start + offset));
  assert.equal(batch.length, 0, 'do not notify before two minutes');
}
({state, batch} = advancePolicy(state, ['image', 'storage', 'moderation'].map(category => ({category, at: start + 120_000})), start + 120_000));
assert.deepEqual(batch.map(event => event.category), ['image', 'storage', 'moderation']);
const firstBatch = state.lastBatchAt;
assert.ok(!JSON.stringify(batch).includes('PRIVATE'));

// Reconstruct the state as after a process restart; the global throttle survives.
state = JSON.parse(JSON.stringify(state));
for (let at = start + 180_000; at < firstBatch + BATCH_MS; at += 60_000) {
  ({state, batch} = advancePolicy(state, [{category: 'image', at}], at));
  assert.equal(batch.length, 0, 'all categories share one hourly batch budget');
}
({state, batch} = advancePolicy(state, [{category: 'image', at: firstBatch + BATCH_MS}], firstBatch + BATCH_MS));
assert.deepEqual(batch.map(event => event.category), ['image'], 'remind only for currently recurring failures');

// New incidents within the hour also respect the same cooldown.
const cooldown = state.lastBatchAt;
for (const offset of [0, 60_000, 120_000]) {
  ({state, batch} = advancePolicy(state, [{category: 'storage', at: cooldown + offset}], cooldown + offset));
  assert.equal(batch.length, 0);
}
({state, batch} = advancePolicy(state, [], cooldown + BATCH_MS));
assert.equal(batch.length, 0, 'a recovered incident must not create a delayed email');

// A quiet gap resets the two-minute grace; duplicate/out-of-order logs cannot extend it.
({state} = advancePolicy(null, [{category: 'image', at: start}], start));
({state, batch} = advancePolicy(state, [{category: 'image', at: start + 121_000}], start + 121_000));
assert.equal(batch.length, 0);
({state, batch} = advancePolicy(state, [{category: 'image', at: start}, {category: 'image', at: start + 121_000}], start + 121_000));
assert.equal(batch.length, 0);
assert.equal(state.streaks.image.first, start + 121_000);

// Exercise the actual Tail -> Durable Object path offline. A newly constructed
// object uses the same persisted cooldown, with logs emitted only after commit.
const values = new Map();
let committed = false;
const storage = {
  async get(key) { return structuredClone(values.get(key)); },
  async put(key, value) { values.set(key, structuredClone(value)); },
  async transaction(action) { committed = false; const result = await action(this); committed = true; return result; },
};
const emitted = [];
const originalError = console.error;
const now = Date.now();
const fixture = [now - 120_000, now - 60_000, now].map(at => trace({event: 'storage_failure'}, at));
try {
  console.error = message => { assert.ok(committed); emitted.push(JSON.parse(message)); };
  let object = new AlertState({storage});
  const env = {ALERT_STATE: {idFromName: name => name, get: () => ({fetch: (url, init) => object.fetch(new Request(url, init))})}};
  await monitor.tail(fixture, env);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].category, 'storage');
  object = new AlertState({storage});
  await monitor.tail(fixture, env);
  assert.equal(emitted.length, 1, 'replayed tail batches and object restarts must not duplicate alerts');
  assert.ok(!JSON.stringify([...values]).includes('PRIVATE'));
} finally { console.error = originalError; }
console.log('Monitoring: grace period, hourly batching, recovery, restart and privacy tests passed.');
