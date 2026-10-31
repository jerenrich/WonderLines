import assert from 'node:assert/strict';
import api from '../workers/coloring-sheets-api/src/index.mjs';
import {runModerationCanary, MODERATION_CANARY_SUBJECT, MODERATION_CANARY_CRON} from '../workers/coloring-sheets-api/src/moderation-canary.mjs';
import {ModerationError, moderationThresholds} from '../workers/coloring-sheets-api/src/moderation.mjs';
import {DIRECT_JEV_MODEL} from '../workers/coloring-sheets-api/src/moderation-profiles.mjs';
import {failuresFromTail, advancePolicy} from '../workers/monitoring/src/policy.mjs';

const safe = () => ({model: DIRECT_JEV_MODEL, answers: Object.fromEntries(Object.keys(moderationThresholds())
  .map(name => [name, {type: 'noul', noul: name === 'all_ages' ? .99 : .01}]))});
const events = [];
const emit = event => events.push(event);
const failOnUse = new Proxy({}, {get() { throw Error('Canary touched account/image/storage resources'); }});
let calls = 0;
const env = {MODERATION_STRATEGY: 'parallel', TYPESAFE_API_KEY: 'PRIVATE', AI_GATEWAY_ID: 'test',
  ACCOUNTS: failOnUse, BUDGET: failOnUse, GENERATIONS: failOnUse,
  AI: {async run(_model, input, options) {
    calls++; assert.ok(JSON.stringify(input).includes(MODERATION_CANARY_SUBJECT));
    assert.equal(options.gateway.skipCache, true); assert.equal(options.gateway.collectLog, false);
    return safe();
  }}};
const previousFetch = globalThis.fetch;
try {
  let providerCalls = 0;
  globalThis.fetch = async (_url, init) => {
    providerCalls++; assert.ok(init.body.includes(MODERATION_CANARY_SUBJECT)); return Response.json(safe());
  };
  const healthy = await runModerationCanary(env, {emit});
  assert.equal(healthy.outcome, 'passed'); assert.equal(healthy.availability, 'both_available');
  assert.equal(calls, 1); assert.equal(providerCalls, 1);

  // The slower fallback is observed even after first approval lets the gate pass.
  let complete;
  const pending = runModerationCanary(env, {emit, moderate: async (_env, subject, observation) => {
    assert.equal(subject, MODERATION_CANARY_SUBJECT);
    observation.waitUntil(new Promise(resolve => { complete = () => {
      observation.onComplete({availability: 'partial', private: 'PRIVATE'}); resolve();
    }; }));
  }});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.length, 1); complete();
  assert.equal((await pending).availability, 'partial');

  for (const error of [new ModerationError('moderation_unavailable', 'PRIVATE', 503, {failure: 'timeout'}),
    new ModerationError('description_not_suitable', 'PRIVATE', 400), Error('PRIVATE')]) {
    const failed = await runModerationCanary(env, {emit, moderate: async () => { throw error; }});
    assert.equal(failed.outcome, 'failed');
    const at = Date.now();
    const failures = failuresFromTail([{scriptName: 'coloring-sheets-api', logs: [{timestamp: at, message: [JSON.stringify(failed)]}]}], at);
    assert.deepEqual(failures, [{category: 'moderation', at, immediate: true}]);
    const first = advancePolicy(null, failures, at);
    assert.equal(first.batch.length, 1);
    assert.equal(advancePolicy(first.state, failures, at).batch.length, 0);
  }
  const partial = failuresFromTail([{scriptName: 'coloring-sheets-api', logs: [{timestamp: 1000,
    message: [JSON.stringify({event: 'moderation_canary', outcome: 'passed', availability: 'partial'})]}]}], 1000);
  assert.deepEqual(partial, [{category: 'moderation', at: 1000}]);
  assert.equal(advancePolicy(null, partial, 1000).batch.length, 0);
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));

  // Exercise the actual scheduled dispatcher. It must not run the hourly R2
  // cleanup or touch account/image state on each periodic invocation.
  const info = console.info; const recorded = [];
  try {
    console.info = value => recorded.push(JSON.parse(value));
    await api.scheduled({cron: MODERATION_CANARY_CRON}, env);
    assert.equal(recorded.length, 1); assert.equal(recorded[0].event, 'moderation_canary');
    assert.equal(recorded[0].outcome, 'passed');
    await api.scheduled({cron: '* * * * *'}, env);
    assert.equal(recorded.length, 1, 'retired minute triggers must not call providers or run R2 cleanup');
  } finally { console.info = info; }
} finally { globalThis.fetch = previousFetch; }
console.log('PASS: periodic production moderation, retained fallback results, failures and safe rejections, shared hourly cap, privacy and no account/image/storage use; offline only.');
