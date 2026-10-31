import assert from 'node:assert/strict';
import {runParallelModeration} from '../workers/coloring-sheets-api/src/parallel-moderation.mjs';
import {moderateSubject, directTypeSafeScores, MODERATION_MODELS, moderationInput, moderationEnvironment} from '../workers/coloring-sheets-api/src/moderation.mjs';
import {DIRECT_JEV_MODEL} from '../workers/coloring-sheets-api/src/moderation-profiles.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Clock {
  time = 0; serial = 0; timers = new Map();
  now = () => this.time;
  setTimer = (fn, ms) => { const id = ++this.serial; this.timers.set(id, {fn, time: this.time + ms}); return id; };
  clearTimer = id => this.timers.delete(id);
  async tick(target) {
    await flush();
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0];
      if (!next || next[1].time > target) break;
      this.time = next[1].time; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = target; await flush();
  }
}
const approved = {allowed: true, reasonCodes: [], scores: {all_ages: .99}};
const rejected = {allowed: false, reasonCodes: ['violence'], scores: {violence: .99}};
function provider(clock, id, at, value, observed) {
  return {id, run: signal => {
    observed.started.push(id);
    return new Promise((resolve, reject) => {
      const cancel = () => { observed.cancelled.push(id); clock.clearTimer(timer); reject(Error('cancelled private text')); };
      const timer = at == null ? null : clock.setTimer(() => {
        signal.removeEventListener('abort', cancel);
        if (value instanceof Error) reject(value); else resolve(value);
      }, at);
      signal.addEventListener('abort', cancel, {once: true});
    });
  }};
}
async function scenario(plans, expected, decisionMs, completedMs, agreement) {
  const clock = new Clock(), observed = {started: [], cancelled: []};
  const pending = runParallelModeration(plans.map(([at, value], i) => provider(clock, 'service-' + i, at, value, observed)), clock);
  let gate, final;
  pending.decision.then(value => { gate = value; }); pending.completion.then(value => { final = value; });
  await flush(); assert.equal(observed.started.length, 2, 'Both services start before either finishes.');
  await clock.tick(decisionMs - 1); assert.equal(gate, undefined, 'Gate must not settle early.');
  await clock.tick(decisionMs); assert.ok(gate); assert.equal(gate.allowed, expected.allowed);
  assert.equal(gate.decisionReason, expected.reason); assert.equal(gate.elapsedMs, decisionMs);
  const snapshot = JSON.stringify(gate);
  if (decisionMs < completedMs) {
    assert.equal(final, undefined, 'Observation continues after immediate approval.');
    assert.equal(observed.cancelled.length, 0, 'Approval must not cancel the slower check.');
  }
  await clock.tick(12000); const result = await pending.completion;
  assert.equal(result.elapsedMs, completedMs); assert.equal(result.decisionElapsedMs, decisionMs);
  assert.equal(result.agreement, agreement); assert.equal(JSON.stringify(gate), snapshot, 'Final disagreement never revises approval.');
  assert.equal(clock.timers.size, 0, 'All timers cleaned after completion.');
  assert.ok(!JSON.stringify(result).includes('private'));
  return result;
}
for (const swapped of [false, true]) {
  const plans = (a, b) => swapped ? [b, a] : [a, b];
  await scenario(plans([200, approved], [1900, approved]), {allowed:true,reason:'both_approved'},1900,1900,'agree');
  await scenario(plans([200, approved], [3000, approved]), {allowed:true,reason:'both_approved'},3000,3000,'agree');
  // Either service vetoes, whichever arrives first, and does not cancel the other.
  await scenario(plans([200, rejected], [1900, approved]), {allowed:false,reason:'rejected'},200,1900,'disagree');
  await scenario(plans([200, approved], [4199, rejected]), {allowed:false,reason:'rejected'},4199,4199,'disagree');
  // A decision exactly at the grace cutoff is late, irrespective of callback order.
  await scenario(plans([200, approved], [4200, rejected]), {allowed:true,reason:'single_approval'},4200,4200,'disagree');
  await scenario(plans([200, approved], [7900, rejected]), {allowed:true,reason:'single_approval'},4200,7900,'disagree');
  const hung = await scenario(plans([200, approved], [null]), {allowed:true,reason:'single_approval'},4200,8000,'incomplete');
  assert.equal(hung.availability,'partial'); assert.ok(hung.providers.some(row=>row.outcome==='timed_out'));
  assert.equal(hung.approvedBy, swapped ? 'service-1' : 'service-0');
  // Grace never extends past the overall deadline.
  await scenario(plans([7000, approved], [null]), {allowed:true,reason:'single_approval'},8000,8000,'incomplete');
  await scenario(plans([200, Error('private provider response')], [7000, approved]), {allowed:true,reason:'single_approval'},7000,7000,'incomplete');
  await scenario(plans([100, Error('private')], [null]), {allowed:null,reason:'overall_timeout'},8000,8000,'incomplete');
  await scenario(plans([200, approved], [300, Error('private')]), {allowed:true,reason:'single_approval'},300,300,'incomplete');
  await scenario(plans([200, Error('private')], [300, rejected]), {allowed:false,reason:'rejected'},300,300,'incomplete');
  await scenario(plans([200, rejected], [null]), {allowed:false,reason:'rejected'},200,8000,'incomplete');
  await scenario(plans([200, rejected], [300, rejected]), {allowed:false,reason:'rejected'},200,300,'agree');
  // A result exactly at the cutoff is timed out, irrespective of callback order.
  await scenario(plans([8000, approved], [null]), {allowed:null,reason:'overall_timeout'},8000,8000,'incomplete');
}
await scenario([[null], [null]], {allowed:null,reason:'overall_timeout'},8000,8000,'incomplete');
await scenario([[100, Error('private')], [200, Error('private')]], {allowed:null,reason:'both_unavailable'},200,200,'incomplete');
await scenario([[100, {allowed:'true'}], [200, approved]], {allowed:true,reason:'single_approval'},200,200,'incomplete');
// An uncooperative provider finishing after the cutoff cannot mutate either record.
{
  const clock = new Clock(); let late;
  const pending = runParallelModeration([{id:'first',run:async()=>approved},{id:'late',run:()=>new Promise(resolve=>{late=resolve;})}],clock);
  await clock.tick(8000); const result = await pending.completion;
  const snapshot = JSON.stringify(result); late(rejected); await flush(); assert.equal(JSON.stringify(result),snapshot);
}
const safe = () => ({model: DIRECT_JEV_MODEL, answers: Object.fromEntries(Object.keys(moderationInput('').questions)
  .map(name => [name, {type: 'noul', noul: name === 'all_ages' ? .99 : .01}]))});
const fetchBefore = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, 'Bearer private-key');
    const input = JSON.parse(init.body); assert.equal(input.model, DIRECT_JEV_MODEL);
    assert.equal(input.state.description, 'flower'); assert.deepEqual(input.questions, moderationInput('flower').questions);
    assert.equal(input.prompt, undefined); return Response.json(safe());
  };
  assert.equal((await directTypeSafeScores({TYPESAFE_API_KEY: 'private-key'}, 'flower')).all_ages, .99);
  assert.equal(calls, 1);
  for (const [response, expectedDetail, expectedStatus] of [
    [() => Response.json({error:'private-key PRIVATE_PROMPT'}, {status:401}), 'http_error',401],
    [() => new Response('PRIVATE_PROMPT', {status:302,headers:{Location:'https://evil.test'}}), 'http_error',302],
    [() => new Response('x'.repeat(65537),{headers:{'Content-Type':'application/json'}}), 'response_too_large',200],
    [() => new Response('PRIVATE_PROMPT',{headers:{'Content-Type':'text/plain'}}), 'content_type',200],
    [() => new Response('{"echo":"PRIVATE_PROMPT"', {headers:{'Content-Type':'application/json'}}), 'invalid_json',200],
    [() => Response.json({...safe(),model:'jev-latest'}), 'model_mismatch',200],
    [() => Response.json({model:DIRECT_JEV_MODEL,answers:{}}), 'invalid_scores',200],
    [() => {const value=safe();value.answers.sexual.noul='0';return Response.json(value);}, 'invalid_scores',200],
  ]) {
    globalThis.fetch = async () => response();
    const logs=[], retained=[];
    const auditEnv={MODERATION_STRATEGY:'parallel',TYPESAFE_API_KEY:'private-key',AI_GATEWAY_ID:'test',AI:{run:async()=>safe()}};
    const gate = await moderateSubject(auditEnv, 'PRIVATE_PROMPT', {waitUntil:p=>retained.push(p),onComplete:value=>logs.push(value)});
    assert.equal(gate.decisionReason,'single_approval'); await Promise.all(retained);
    const provider=logs[0].providers.find(row=>row.id===DIRECT_JEV_MODEL);
    assert.equal(provider.failureDetail,expectedDetail); assert.equal(provider.httpStatus,expectedStatus);
    assert.equal(logs[0].availability,'partial');
    assert.ok(!JSON.stringify({gate,logs}).includes('private-key'));
    assert.ok(!JSON.stringify({gate,logs}).includes('PRIVATE_PROMPT'),'Neither gate nor completed error logs may contain user text.');
  }
  globalThis.fetch = async () => { throw Error('private-key upstream prompt'); };
  await assert.rejects(directTypeSafeScores({TYPESAFE_API_KEY: 'private-key'}, 'flower'), error=>error.code==='moderation_unavailable' && error.diagnostics.failureDetail==='network_error');
  const env = {MODERATION_STRATEGY: 'parallel', TYPESAFE_API_KEY: 'private-key', AI_GATEWAY_ID: 'test',
    AI: {run: async (model, input, options) => {
      assert.equal(model, MODERATION_MODELS.clef); assert.equal(input.state.description, 'flower');
      assert.ok(options.signal); return safe();
    }}};
  globalThis.fetch = async () => Response.json(safe());
  const retained = [], observations = [];
  const observe = {waitUntil: promise => retained.push(promise), onComplete: value => observations.push(value)};
  const accepted = await moderateSubject(env, 'flower', observe);
  assert.equal(accepted.decisionReason, 'both_approved');
  await Promise.all(retained); assert.equal(observations[0].agreement, 'agree');
  for (const version of [undefined, null, '1', '3', '02', 2]) {
    const countBefore = calls;
    const legacy = await moderateSubject(moderationEnvironment(env, version), 'flower');
    assert.equal(legacy.strategy, undefined); assert.equal(calls, countBefore, 'Older consent cannot disclose input directly to TypeSafe.');
  }
  assert.equal(moderationEnvironment(env, '2'), env);
  globalThis.fetch = async () => { const value = safe(); value.answers.violence.noul = .99; return Response.json(value); };
  await assert.rejects(moderateSubject(env, 'flower', observe), error =>
    error.code === 'description_not_suitable' && error.reasonCodes[0] === 'violence', 'A Jev rejection vetoes a Clef approval.');
  await Promise.all(retained); assert.equal(observations.at(-1).agreement, 'disagree');
  const unsafeAI = {run: async () => {const value=safe(); value.answers.violence.noul=.99; return value;}};
  await assert.rejects(moderateSubject({...env,AI:unsafeAI}, 'flower', observe), error => error.code === 'description_not_suitable' && error.reasonCodes[0] === 'violence');
  globalThis.fetch = async () => Response.json({error: 'private-key'}, {status: 429});
  const degraded = await moderateSubject(env, 'flower', observe);
  assert.equal(degraded.decisionReason, 'single_approval'); await Promise.all(retained);
  assert.equal(observations.at(-1).availability, 'partial');
  assert.equal(observations.at(-1).providers[1].httpStatus, 429); assert.ok(!JSON.stringify(observations).includes('private-key'));
  await assert.rejects(moderateSubject({...env, AI: {run: async () => { throw Error('private-key'); }}}, 'flower'), error =>
    error.code === 'moderation_unavailable' && error.diagnostics.failure === 'no_valid_decision');
  for (const patch of [{TYPESAFE_API_KEY: undefined}, {TYPESAFE_API_KEY: 'bad key'}, {AI: undefined}, {AI_GATEWAY_ID: ''}]) {
    await assert.rejects(moderateSubject({...env, ...patch}, 'flower'), error =>
      error.code === 'moderation_unavailable' && error.diagnostics.failure === 'configuration');
  }
  await assert.rejects(moderateSubject({...env, MODERATION_STRATEGY: 'unknown'}, 'flower'), {code: 'moderation_unavailable'});
} finally { globalThis.fetch = fetchBefore; }
console.log('PASS: either service vetoes in either arrival order, approval waits a bounded grace for the second decision, single approval only after failure or grace expiry, independent retained observations, disagreements, eight-second cutoff/cancellation, late results, partial/total outage, pinned direct Jev, bounded parsing and credential-safe diagnostics; no network.');
