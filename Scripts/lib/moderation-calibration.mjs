// Offline fitting only: validation labels are never used to select thresholds.
export const SCORE_NAMES = ['all_ages', 'sexual', 'violence', 'hate', 'adult', 'frightening', 'bypass'];
export const validScores = scores => SCORE_NAMES.every(key => Number.isFinite(scores?.[key]) && scores[key] >= 0 && scores[key] <= 1);
export const accepts = (scores, thresholds) => validScores(scores) && SCORE_NAMES.every(key =>
  key === 'all_ages' ? scores[key] >= thresholds[key] : scores[key] <= thresholds[key]);
export function summarize(rows, thresholds) {
  const valid = rows.filter(row => validScores(row.scores));
  const safe = valid.filter(row => row.expected), unsafe = valid.filter(row => !row.expected);
  const falseRejects = safe.filter(row => !accepts(row.scores, thresholds));
  const falseAccepts = unsafe.filter(row => accepts(row.scores, thresholds));
  return {total: rows.length, unavailable: rows.length - valid.length, harmless: safe.length,
    harmlessApproved: safe.length - falseRejects.length, unsafe: unsafe.length, unsafeApproved: falseAccepts.length,
    falseRejects: falseRejects.map(row => row.name), falseAccepts: falseAccepts.map(row => row.name)};
}
export function fitThresholds(rows, baseline, {maxStates = 50000} = {}) {
  const valid = rows.filter(row => validScores(row.scores));
  const safe = valid.filter(row => row.expected), unsafe = valid.filter(row => !row.expected);
  if (!safe.length || !unsafe.length) throw Error('Calibration requires valid harmless and unsafe examples');
  const id = profile => SCORE_NAMES.map(key => profile[key]).join(',');
  const evaluate = profile => ({profile, good: safe.filter(row => accepts(row.scores, profile)).length,
    missed: unsafe.filter(row => accepts(row.scores, profile))});
  const strict = Object.fromEntries(SCORE_NAMES.map(key => [key, key === 'all_ages' ? 1 : 0]));
  let best = evaluate(baseline);
  if (best.missed.length) best = evaluate(strict);
  if (best.missed.length) throw Error('No safe starting profile; review inseparable labels');
  // Every profile accepting a subset of benign examples contains that subset's
  // smallest axis-aligned bounding box. Starting at the box containing all benign
  // examples and excluding each admitted unsafe point therefore spans all better
  // attainable approval sets. Each exclusion has at most seven possible axes.
  const initial = Object.fromEntries(SCORE_NAMES.map(key => [key,
    key === 'all_ages' ? Math.min(...safe.map(row => row.scores[key])) : Math.max(...safe.map(row => row.scores[key]))]));
  const stack = [evaluate(initial)], seen = new Set();
  let examined = 0;
  while (stack.length && examined < maxStates) {
    const candidate = stack.pop(), key = id(candidate.profile);
    if (seen.has(key) || candidate.good <= best.good) continue;
    seen.add(key); examined++;
    if (!candidate.missed.length) { best = candidate; continue; }
    const point = candidate.missed[0].scores;
    const branches = [];
    for (const axis of SCORE_NAMES) {
      const value = point[axis] + (axis === 'all_ages' ? .000001 : -.000001);
      if (value < 0 || value > 1) continue;
      const child = evaluate({...candidate.profile, [axis]: value});
      if (child.good > best.good) branches.push(child);
    }
    branches.sort((a,b) => a.good-b.good || b.missed.length-a.missed.length);
    stack.push(...branches);
  }
  return {thresholds: best.profile, calibration: summarize(rows, best.profile),
    examinedStates: examined, searchExhausted: stack.length === 0,
    method: 'Branch-and-bound search minimizes observed harmless rejections among seven-threshold profiles subject to zero observed unsafe approvals on calibration data. Search is capped at 50000 states; searchExhausted reports whether it finished. Validation data never participates. No guarantee of future safety.'};
}
export function evaluatePair(rows, profiles) {
  const valid = row => validScores(row?.scores);
  const outcome = (row, name) => valid(row[name]) ? accepts(row[name].scores, profiles[name]) : null;
  const both = rows.filter(row => valid(row.clef) && valid(row.jev));
  // Production veto rule: with both decisions available, both must approve.
  const accepted = row => outcome(row, 'clef') === true && outcome(row, 'jev') === true;
  return {total: rows.length, pairedValid: both.length, unavailablePairs: rows.length - both.length,
    harmless: both.filter(row => row.expected).length,
    harmlessApproved: both.filter(row => row.expected && accepted(row)).length,
    unsafe: both.filter(row => !row.expected).length,
    unsafeApproved: both.filter(row => !row.expected && accepted(row)).length,
    falseRejects: both.filter(row => row.expected && !accepted(row)).map(row => row.name),
    falseAccepts: both.filter(row => !row.expected && accepted(row)).map(row => row.name),
    // Each service must also be assessed as the only available decision.
    singleServiceFallback: Object.fromEntries(['clef','jev'].map(name => [name,
      summarize(rows.map(row => ({...row, scores: row[name]?.scores})), profiles[name])]))};
}
