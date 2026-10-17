// Billing metrics remain in account jobs. Duplicate diagnostic ledgers are
// migrated to Workers Logs, which expire natively; sweep only old R2 copies.
export const DIAGNOSTIC_RETENTION_DAYS = 7;
const DAY = 86400000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LEGACY_USAGE_KEY = new RegExp(`^${UUID}/${UUID}\\.usage\\.json$`, 'i');
export async function cleanLegacyUsageLogs(bucket, now = Date.now()) {
  if (!bucket || !Number.isSafeInteger(now) || now < DIAGNOSTIC_RETENTION_DAYS * DAY) throw new Error('invalid_diagnostic_retention_configuration');
  const cutoff = now - DIAGNOSTIC_RETENTION_DAYS * DAY;
  let cursor, scanned = 0, removed = 0;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const listed = await bucket.list({limit: 1000, ...(cursor ? {cursor} : {})});
    if (!Array.isArray(listed.objects)) throw new Error('invalid_diagnostic_listing');
    const expired = [];
    for (const object of listed.objects) {
      scanned++;
      if (!LEGACY_USAGE_KEY.test(object.key)) continue;
      const uploaded = object.uploaded instanceof Date ? object.uploaded.getTime() : NaN;
      if (!Number.isFinite(uploaded)) throw new Error('invalid_diagnostic_timestamp');
      if (uploaded < cutoff) expired.push(object.key);
    }
    if (expired.length) { await bucket.delete(expired); removed += expired.length; }
    if (!listed.truncated) return {event: 'legacy_usage_log_retention', retentionDays: DIAGNOSTIC_RETENTION_DAYS, scanned, removed};
    if (typeof listed.cursor !== 'string' || !listed.cursor || seen.has(listed.cursor)) throw new Error('invalid_diagnostic_cursor');
    seen.add(listed.cursor); cursor = listed.cursor;
  }
  throw new Error('diagnostic_retention_scan_limit');
}
