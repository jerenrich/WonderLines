// Offline threshold analysis of recorded live Clef answers; no API calls.
import {readFileSync, writeFileSync} from 'node:fs';
import {moderationScores, moderationDecision, moderationThresholds, MODERATION_MODELS} from '../workers/coloring-sheets-api/src/moderation.mjs';
const baseline = {all_ages: 0.95, sexual: 0.05, violence: 0.20, hate: 0.05, adult: 0.05, frightening: 0.25, bypass: 0.10};
const recommended = moderationThresholds(MODERATION_MODELS.clef);
const candidates = {
  baseline,
  suitability90: {...baseline, all_ages: 0.90, adult: 0.10},
  suitability85: {...baseline, all_ages: 0.85, adult: 0.10},
  initialCandidate: {...baseline, all_ages: 0.80, adult: 0.10},
  recommended,
  suitability75: {...baseline, all_ages: 0.75, adult: 0.10},
};
function evaluate(rows, limits) {
  const falsePositives = [], falseNegatives = [];
  let safeCount = 0, unsuitableCount = 0;
  for (const row of rows) {
    if (typeof row.expected !== 'boolean') throw Error('Missing expected classification');
    const response = {answers: Object.fromEntries(Object.entries(row.scores).map(([name, noul]) => [name, {type: 'noul', noul}]))};
    const scores = moderationScores(response);
    const allowed = scores.all_ages >= limits.all_ages && Object.entries(limits).every(([name, limit]) => name === 'all_ages' || scores[name] <= limit);
    if (limits === recommended && allowed !== moderationDecision(response, MODERATION_MODELS.clef)) throw Error('Candidate disagrees with Worker policy');
    if (row.expected) { safeCount++; if (!allowed) falsePositives.push(row.name); }
    else { unsuitableCount++; if (allowed) falseNegatives.push(row.name); }
  }
  return {safeCount, safeAccepted: safeCount - falsePositives.length, safeRejected: falsePositives.length,
    unsuitableCount, unsuitableRejected: unsuitableCount - falseNegatives.length, unsuitableAccepted: falseNegatives.length,
    falsePositives, falseNegatives};
}
const sources = {
  reference: '../docs/moderation/2026-10-04-clef-v5-validation.json',
  additional: '../docs/moderation/2026-10-04-clef-calibration-holdout.json',
};
const datasets = Object.fromEntries(Object.entries(sources).map(([name, path]) => {
  const data = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  if (data.model !== MODERATION_MODELS.clef) throw Error('Expected recorded Clef answers');
  return [name, data.results];
}));
datasets.combined = Object.values(datasets).flat();
const report = {model: MODERATION_MODELS.clef, changes: ['overall suitability: 95% to 73%', 'sexual content: 5% to 10%', 'violence: 20% to 29%', 'hate: 5% to 7%', 'adult themes: 5% to 10%', 'safety bypass: 10% to 51%'],
  methodology: 'Candidates chosen from the 74 reference cases and compared on 64 additional prompts. No prompt changes. Limits are inclusive. Scores are from one evaluation per case; this is not a guarantee for arbitrary prompts.',
  profiles: candidates,
  evaluations: Object.fromEntries(Object.entries(candidates).map(([name, limits]) => [name,
    Object.fromEntries(Object.entries(datasets).map(([set, rows]) => [set, evaluate(rows, limits)]))]))};
const output = JSON.stringify(report, null, 2) + '\n';
const destination = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (destination) writeFileSync(destination, output); else process.stdout.write(output);
