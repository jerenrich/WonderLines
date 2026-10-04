import assert from 'node:assert/strict';
import {moderateSubject, moderationDecision, moderationInput, MODERATION_MODEL, MODERATION_MODELS, moderationModel} from '../workers/coloring-sheets-api/src/moderation.mjs';

const names = Object.keys(moderationInput('').questions);
export const safeModerationResult = () => ({answers: Object.fromEntries(names.map(name =>
  [name, {type: 'noul', noul: name === 'all_ages' ? 0.99 : 0.01}]))});
assert.equal(moderationDecision(safeModerationResult()), true);
assert.equal(moderationDecision({state: {description: 'ignored echoed content'}, result: safeModerationResult()}), true);
assert.equal(moderationDecision({success: true, result: {state: {}, result: safeModerationResult()}}), true);
for (const invalid of [
  {success: false, result: safeModerationResult()},
  {success: true, result: {success: false, result: safeModerationResult()}},
  {result: JSON.stringify(safeModerationResult())},
  {state: safeModerationResult()},
]) assert.throws(() => moderationDecision(invalid));
for (const name of names) {
  const uncertain = safeModerationResult();
  uncertain.answers[name].noul = name === 'all_ages' ? 0.94 : ['violence', 'bypass'].includes(name) ? 0.11 : 0.06;
  assert.equal(moderationDecision(uncertain), false, name + ' uncertainty must block');
  for (const value of [undefined, null, '0', NaN, Infinity, -0.01, 1.01]) {
    const malformed = safeModerationResult(); malformed.answers[name].noul = value;
    assert.throws(() => moderationDecision(malformed));
  }
  const missing = safeModerationResult(); delete missing.answers[name];
  assert.throws(() => moderationDecision(missing));
  const wrongType = safeModerationResult(); wrongType.answers[name].type = 'choice';
  assert.throws(() => moderationDecision(wrongType));
}
assert.throws(() => moderationDecision({}));
for (const [score, allowed] of [[0.0566, true], [0.10, true], [0.1001, false]]) {
  const result = safeModerationResult(); result.answers.bypass.noul = score;
  assert.equal(moderationDecision(result), allowed, 'Bypass threshold is inclusive at 10%.');
}
const harmlessAdventure = safeModerationResult(); harmlessAdventure.answers.violence.noul = 0.08;
assert.equal(moderationDecision(harmlessAdventure), true);
harmlessAdventure.answers.all_ages.noul = 0.94;
assert.equal(moderationDecision(harmlessAdventure), false, 'A low hazard score never overrides uncertain overall suitability.');
let calls = 0;
const env = {AI_GATEWAY_ID: 'existing-gateway', AI: {async run(model, input, options) {
  calls++; assert.equal(model, MODERATION_MODEL);
  assert.equal(input.state.description, 'A friendly dragon. Complexity: intricate outlines.');
  assert.deepEqual(options.gateway, {id: 'existing-gateway', skipCache: true, collectLog: false});
  return safeModerationResult();
}}};
await moderateSubject(env, 'A friendly dragon. Complexity: intricate outlines.');
assert.equal(calls, 1);
for (const [name, model] of Object.entries(MODERATION_MODELS)) {
  assert.equal(moderationModel({MODERATION_MODEL: name}), model);
  assert.equal(moderationModel({MODERATION_MODEL: model}), model);
  await moderateSubject({...env, MODERATION_MODEL: name, AI: {async run(actualModel, input) {
    assert.equal(actualModel, model);
    assert.equal(input.model, name === 'jev' ? undefined : name);
    assert.deepEqual(input.questions, moderationInput('flower').questions);
    return safeModerationResult();
  }}}, 'flower');
}
await assert.rejects(moderateSubject({...env, MODERATION_MODEL: 'unknown'}, 'flower'), {code: 'moderation_unavailable'});

for (const broken of [{}, {...env, AI: undefined}, {...env, AI_GATEWAY_ID: ''}, {...env, AI_GATEWAY_ID: 'https://untrusted.test'}]) {
  await assert.rejects(moderateSubject(broken, 'flower'), {code: 'moderation_unavailable', status: 503});
}
assert.equal(calls, 1, 'Invalid local configuration must not call Jev');
for (const result of [null, {answers: {}}, {success: false, errors: [{message: 'private'}]}]) {
  await assert.rejects(moderateSubject({...env, AI: {run: async () => result}}, 'flower'), {code: 'moderation_unavailable', status: 503});
}
await assert.rejects(moderateSubject({...env, AI: {run: async () => { throw new Error('private upstream content'); }}}, 'flower'),
  error => error.code === 'moderation_unavailable' && !error.message.includes('private'));
const blocked = safeModerationResult(); blocked.answers.violence.noul = 0.99;
await assert.rejects(moderateSubject({...env, AI: {run: async () => blocked}}, 'violent content'), {code: 'description_not_suitable', status: 400});
// Exercise a hung inference without waiting eight seconds in the offline suite.
const originalTimeout = globalThis.setTimeout;
try {
  globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 8000); return originalTimeout(callback, 0); };
  await assert.rejects(moderateSubject({...env, AI: {run: () => new Promise(() => {})}}, 'flower'), {code: 'moderation_unavailable', status: 503});
} finally { globalThis.setTimeout = originalTimeout; }
console.log('Moderation protocol tests passed (synthetic responses; no model calls).');
