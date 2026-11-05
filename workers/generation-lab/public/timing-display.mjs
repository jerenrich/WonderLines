const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function requestTimeMs(metrics) {
  if (!metrics) return null;
  if (duration(metrics.requestMs)) return metrics.requestMs;
  // Older comparisons retained total and queue time. Never substitute fal's
  // provider-reported compute time, which excludes its external queue/polling.
  if (duration(metrics.elapsedMs) && duration(metrics.queueMs) && metrics.elapsedMs >= metrics.queueMs) return metrics.elapsedMs - metrics.queueMs;
  if (['openai', 'workers-ai', 'google-ai-studio'].includes(metrics.provider) && duration(metrics.inferenceMs)) return metrics.inferenceMs;
  return null;
}

export const formatDuration = value => duration(value) ? `${(value / 1000).toFixed(1)}s` : '—';

export function modelTiming(cells, modelId) {
  const completed = cells.filter(cell => cell.model === modelId && cell.status === 'completed');
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const total = completed.map(cell => cell.metrics?.elapsedMs).filter(duration);
  const request = completed.map(cell => requestTimeMs(cell.metrics)).filter(duration);
  return {requestMs: average(request), elapsedMs: average(total), requestCount: request.length, totalCount: total.length};
}
