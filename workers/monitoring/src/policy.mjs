export const GRACE_MS = 120_000;
export const BATCH_MS = 3_600_000;
export const categories = ['image', 'storage', 'moderation'];
const producers = new Set(['coloring-sheets-api', 'wonderlines-compare']);

// Consume only known operational fields. Never forward requests, prompts,
// exception text, provider responses, generation IDs or arbitrary log data.
export function failuresFromTail(traces, now) {
  const failures = [];
  for (const trace of traces ?? []) {
    if (!producers.has(trace.scriptName)) continue;
    for (const log of trace.logs ?? []) {
      if (!Number.isFinite(log.timestamp) || log.timestamp < now - 300_000 || log.timestamp > now + 5_000) continue;
      for (const message of log.message ?? []) {
        let event;
        try { event = typeof message === 'string' ? JSON.parse(message) : message; } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        const at = Math.min(now, log.timestamp);
        if ((['comparison_image', 'generation_result'].includes(event.event) && event.outcome === 'failed') ||
            (event.event === 'fal_usage' && event.state === 'failed') ||
            (event.event === 'comparison_start_failed' && event.status >= 500 && event.errorCode !== 'moderation_unavailable')) {
          failures.push({category: 'image', at});
        }
        if (['storage_failure', 'comparison_library_unavailable', 'legacy_usage_log_retention_failed'].includes(event.event) ||
            (event.event === 'comparison_image' && event.outcome === 'persistence_retry') ||
            ['result_save_failed', 'result_unavailable'].includes(event.errorCode)) {
          failures.push({category: 'storage', at});
        }
        const blockingModeration = event.outcome === 'moderation_unavailable' || event.errorCode === 'moderation_unavailable';
        if (blockingModeration || (['description_moderation', 'description_moderation_complete'].includes(event.event) &&
            (event.degraded === true || event.degraded === 'true' || ['partial', 'unavailable'].includes(event.availability)))) {
          failures.push({category: 'moderation', at, ...(blockingModeration ? {immediate: true} : {})});
        }
      }
    }
  }
  return failures.sort((a, b) => a.at - b.at);
}

// Persistence is repeated failures spanning two minutes, with no gap longer
// than two minutes. Blocking moderation failures qualify immediately. Other
// single errors cannot become incidents just by aging.
// Successes do not mask repeated failures affecting only some requests.
export function advancePolicy(previous, failures, now) {
  const state = structuredClone(previous ?? {streaks: {}, lastBatchAt: null});
  for (const {category, at, immediate} of failures) {
    if (!categories.includes(category) || !Number.isFinite(at) || at > now || at < now - 300_000) continue;
    const streak = state.streaks[category];
    if (!streak || at - streak.last > GRACE_MS) state.streaks[category] = {first: at, last: at, count: 1};
    else if (at > streak.last) { streak.last = at; streak.count++; }
    if (category === 'moderation' && immediate === true) {
      const current = state.streaks[category];
      current.immediateAt = Math.max(current.immediateAt ?? -Infinity, at);
    }
  }
  for (const category of categories) {
    if (state.streaks[category] && now - state.streaks[category].last > GRACE_MS) delete state.streaks[category];
  }
  const eligible = categories.filter(category => {
    const streak = state.streaks[category];
    return streak && (streak.last - streak.first >= GRACE_MS ||
      (category === 'moderation' && now - (streak.immediateAt ?? -Infinity) <= GRACE_MS));
  });
  const batch = eligible.length && (state.lastBatchAt === null || now - state.lastBatchAt >= BATCH_MS)
    ? eligible.map(category => ({event: 'operational_alert_batch', category,
        failureSpanSeconds: Math.floor((state.streaks[category].last - state.streaks[category].first) / 1000),
        observations: state.streaks[category].count})) : [];
  if (batch.length) state.lastBatchAt = now;
  return {state, batch};
}
