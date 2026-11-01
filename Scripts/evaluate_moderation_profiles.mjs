// Offline: evaluate the source moderation profiles against saved live scores.
// Usage: node Scripts/evaluate_moderation_profiles.mjs --scores=path [--report=path]
import {readFile, writeFile} from 'node:fs/promises';
import {parallelClefThresholds, directJevThresholds, PARALLEL_MODERATION_POLICY} from '../workers/coloring-sheets-api/src/moderation-profiles.mjs';
import {summarize, evaluatePair} from './lib/moderation-calibration.mjs';
const arg = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
if (!arg('scores')) throw Error('Use --scores=path [--report=path]');
const document = JSON.parse(await readFile(arg('scores'), 'utf8'));
const profiles = {clef: parallelClefThresholds, jev: directJevThresholds};
const splits = ['calibration', 'validation', 'holdout'];
const rows = split => document.results.filter(row => row.split === split);
const report = {computedAt: new Date().toISOString(), policy: PARALLEL_MODERATION_POLICY, decisionRule: 'veto',
  scores: arg('scores'), fixtureHash: document.fixtureHash, rubricHash: document.rubricHash, jevModel: document.jevModel,
  providers: Object.fromEntries(Object.entries(profiles).map(([name, thresholds]) => [name, {thresholds,
    ...Object.fromEntries(splits.map(split => [split, summarize(rows(split).map(row => ({...row, scores: row[name]?.scores})), thresholds)]))}])),
  paired: Object.fromEntries(splits.map(split => [split, evaluatePair(rows(split), profiles)])),
  limitation: 'Observed sample results only; small, correlated samples cannot prove future safety. Single-service rows show the fallback used only when the other service is unavailable or slow.'};
if (arg('report')) await writeFile(arg('report'), JSON.stringify(report, null, 2) + '\n');
for (const split of splits) {
  const pair = report.paired[split];
  console.log(`${split}: both services ${pair.harmlessApproved}/${pair.harmless} harmless approved, ${pair.unsafeApproved}/${pair.unsafe} unsafe approved` +
    ['clef', 'jev'].map(name => `; ${name} alone ${pair.singleServiceFallback[name].unsafeApproved} unsafe approved ${JSON.stringify(pair.singleServiceFallback[name].falseAccepts)}`).join(''));
}
