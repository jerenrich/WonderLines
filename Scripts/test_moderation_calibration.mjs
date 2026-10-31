import assert from 'node:assert/strict';
import {SCORE_NAMES, fitThresholds, summarize, evaluatePair} from './lib/moderation-calibration.mjs';
const scores = (overall, violence) => Object.fromEntries(SCORE_NAMES.map(key => [key, key === 'all_ages' ? overall : key === 'violence' ? violence : .01]));
const baseline = Object.fromEntries(SCORE_NAMES.map(key => [key, key === 'all_ages' ? .95 : .3]));
const rows = [{name: 'gentle', expected: true, scores: scores(.8,.1)}, {name: 'fantasy', expected: true, scores: scores(.7,.4)},
  {name: 'unsafe', expected: false, scores: scores(.5,.9)}, {name: 'missing', expected: false}];
const fit = fitThresholds(rows, baseline, {beamWidth: 4, rounds: 3});
assert.equal(fit.calibration.harmlessApproved, 2); assert.equal(fit.calibration.unsafeApproved, 0);
assert.equal(fit.calibration.unavailable, 1);
assert.deepEqual(fitThresholds(rows, baseline, {beamWidth: 4, rounds: 3}), fit);
assert.throws(() => fitThresholds(rows.filter(row => row.expected), baseline));
assert.equal(summarize([{name:'bad', expected:true, scores:{all_ages:NaN}}], baseline).unavailable, 1);
const pair = evaluatePair([{name:'both',expected:true,clef:{scores:scores(.99,.1)},jev:{scores:scores(.99,.1)}},
  {name:'veto',expected:false,clef:{scores:scores(.99,.1)},jev:{scores:scores(.99,.9)}},
  {name:'missing',expected:false,clef:{scores:scores(.99,.1)}}], {clef:baseline,jev:baseline});
assert.equal(pair.pairedValid,2); assert.equal(pair.unsafeApproved,1);
assert.equal(pair.singleServiceFallback.clef.unsafeApproved,2,'A combined pass must not conceal unsafe single-provider fallback.');
assert.equal(pair.singleServiceFallback.jev.unavailable,1);
console.log('PASS: deterministic threshold fitting, unsafe-approval constraint, malformed/missing evidence, first-approval union and independent fallback evaluation; no network.');

// Replay both live models through the production decision/coordinator functions.
// This verifies that the selected source profiles match the published evidence.
{
  const {readFileSync} = await import('node:fs');
  const {assessModerationScores} = await import('../workers/coloring-sheets-api/src/moderation.mjs');
  const {parallelClefThresholds, directJevThresholds} = await import('../workers/coloring-sheets-api/src/moderation-profiles.mjs');
  const {runParallelModeration} = await import('../workers/coloring-sheets-api/src/parallel-moderation.mjs');
  const recorded = JSON.parse(readFileSync(new URL('../docs/moderation/2026-10-31/parallel-live-scores.json', import.meta.url), 'utf8'));
  const evidence = JSON.parse(readFileSync(new URL('../docs/moderation/2026-10-31/first-approval-calibration-report.json', import.meta.url), 'utf8'));
  assert.deepEqual(parallelClefThresholds, evidence.providers.clef.thresholds);
  assert.deepEqual(directJevThresholds, evidence.providers.jev.thresholds);
  const counts = {};
  for (const row of recorded.results) {
    const a = assessModerationScores(row.clef.scores, parallelClefThresholds);
    const b = assessModerationScores(row.jev.scores, directJevThresholds);
    const pending = runParallelModeration([{id:'clef',run:async()=>({...a,scores:row.clef.scores})},
      {id:'jev',run:async()=>({...b,scores:row.jev.scores})}]);
    const result = await pending.decision; await pending.completion;
    assert.equal(result.allowed, a.allowed || b.allowed);
    const count = counts[row.split] ??= {harmlessApproved:0,unsafeApproved:0};
    if(result.allowed)count[row.expected?'harmlessApproved':'unsafeApproved']++;
  }
  for (const [split, count] of Object.entries(counts)) {
    assert.equal(count.harmlessApproved, evidence.paired[split].harmlessApproved);
    assert.equal(count.unsafeApproved, 0);
  }
  console.log('PASS: 610 recorded live score sets replay through calibrated production profiles and first-approval union coordinator; zero unsafe approvals in recorded calibration/validation/final-test examples.');
}
