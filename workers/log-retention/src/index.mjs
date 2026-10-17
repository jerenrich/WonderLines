// Legacy AI Gateway logs do not inherit Workers Logs' age-based retention.
// Keep management credentials isolated from the public generation service.
export const POLICY = Object.freeze({
  accountId: '994f60c144bd9dd9bc2333bd3abba832',
  gatewayId: 'coloring-sheets',
  retentionDays: 7,
  cron: '17 * * * *',
  batchLimit: 10000,
});
const DAY = 86400000;
const BASE = `https://api.cloudflare.com/client/v4/accounts/${POLICY.accountId}/ai-gateway/gateways/${POLICY.gatewayId}/logs`;
export class RetentionError extends Error {
  constructor(code) { super(code); this.name = 'RetentionError'; this.code = code; }
}
function query(cutoff, deletion = false) {
  // Match Cloudflare's official SDK: allowDots=true, arrayFormat=repeat.
  // There is exactly one filter, with exactly one timestamp value.
  const params = new URLSearchParams({
    'filters.key': 'created_at', 'filters.operator': 'lt', 'filters.value': cutoff,
    order_by: 'created_at', order_by_direction: 'asc',
    ...(deletion ? {limit: String(POLICY.batchLimit)} : {per_page: '1'}),
  });
  return `${BASE}?${params}`;
}
function summary(data, cutoff) {
  const count = data.result_info?.total_count;
  if (!Array.isArray(data.result) || !Number.isSafeInteger(count) || count < 0 ||
      (count === 0) !== (data.result.length === 0)) throw new RetentionError('invalid_log_summary');
  // A bad or ignored date filter must never lead to deletion of recent logs.
  for (const row of data.result) {
    const timestamp = Date.parse(row.created_at);
    if (!Number.isFinite(timestamp) || timestamp >= Date.parse(cutoff)) throw new RetentionError('unsafe_log_selection');
  }
  return count;
}
export async function runRetention(env, {now = Date.now(), fetcher = globalThis.fetch} = {}) {
  if (!['dry-run', 'enforce'].includes(env.RETENTION_MODE)) throw new RetentionError('invalid_retention_mode');
  const token = env.CLOUDFLARE_LOG_RETENTION_TOKEN;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new RetentionError('retention_credential_missing');
  if (!Number.isSafeInteger(now) || now < DAY * POLICY.retentionDays) throw new RetentionError('invalid_retention_clock');
  const cutoff = new Date(now - POLICY.retentionDays * DAY).toISOString();
  const api = async (url, method = 'GET') => {
    let response, data;
    try {
      response = await fetcher(url, {method, redirect: 'error',
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
        signal: AbortSignal.timeout(30000)});
    } catch { throw new RetentionError('cloudflare_request_failed'); }
    if (!response.ok) throw new RetentionError(response.status === 401 || response.status === 403 ? 'retention_credential_rejected' : 'cloudflare_api_failed');
    try { data = await response.json(); } catch { throw new RetentionError('invalid_cloudflare_response'); }
    if (data.success !== true) throw new RetentionError('cloudflare_operation_failed');
    return data;
  };
  // Validate filter parsing against a date before any Gateway could exist.
  // Do not trust a successful HTTP response alone for a destructive filter.
  if (summary(await api(query('1970-01-01T00:00:00.000Z')), '1970-01-01T00:00:00.000Z') !== 0) throw new RetentionError('unsafe_log_selection');
  const before = summary(await api(query(cutoff)), cutoff);
  const report = {event: 'gateway_log_retention', gateway: POLICY.gatewayId,
    mode: env.RETENTION_MODE, retentionDays: POLICY.retentionDays, cutoff,
    expiredBefore: before, expiredAfter: before, removed: 0};
  if (env.RETENTION_MODE === 'dry-run' || before === 0) return report;
  await api(query(cutoff, true), 'DELETE');
  const after = summary(await api(query(cutoff)), cutoff);
  if (after >= before) throw new RetentionError('retention_progress_unverified');
  return {...report, expiredAfter: after, removed: before - after};
}
export default {
  // No HTTP administration endpoint, routes, R2, or account bindings.
  fetch() { return new Response('Not found', {status: 404}); },
  async scheduled(_event, env) {
    try { console.info(JSON.stringify(await runRetention(env))); }
    catch (error) {
      const code = error instanceof RetentionError ? error.code : 'retention_internal_error';
      // Never log API response bodies, descriptions, images, or credentials.
      console.error(JSON.stringify({event: 'gateway_log_retention_failed', gateway: POLICY.gatewayId, code}));
      throw new Error(code);
    }
  },
};
