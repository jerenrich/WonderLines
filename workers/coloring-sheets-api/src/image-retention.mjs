import {isUUID} from './composition.mjs';

const DAY = 86400000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IMAGE_KEY = new RegExp(`^(${UUID})/${UUID}\\.png$`, 'i');

// The bucket lifecycle cannot express "all accounts except the comparison
// account". Keep app recovery expiry here; comparison eviction owns its files.
export async function cleanExpiredRecoveryImages(bucket, comparisonAccountId, now = Date.now()) {
  // Fail closed: missing configuration must never make comparison files expire.
  if (!bucket || !isUUID(comparisonAccountId) || !Number.isSafeInteger(now) || now < DAY) {
    throw new Error('invalid_image_retention_configuration');
  }
  let cursor, scanned = 0, removed = 0;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const listed = await bucket.list({limit:1000, ...(cursor ? {cursor} : {})});
    if (!Array.isArray(listed.objects)) throw new Error('invalid_image_retention_listing');
    const expired = [];
    for (const object of listed.objects) {
      scanned++;
      const match = IMAGE_KEY.exec(object.key);
      if (!match || match[1].toLowerCase() === comparisonAccountId.toLowerCase()) continue;
      const uploaded = object.uploaded instanceof Date ? object.uploaded.getTime() : NaN;
      if (!Number.isFinite(uploaded)) throw new Error('invalid_image_retention_timestamp');
      if (uploaded < now - DAY) expired.push(object.key);
    }
    if (expired.length) { await bucket.delete(expired); removed += expired.length; }
    if (!listed.truncated) return {event:'recovery_image_retention', retentionHours:24, scanned, removed};
    if (typeof listed.cursor !== 'string' || !listed.cursor || seen.has(listed.cursor)) throw new Error('invalid_image_retention_cursor');
    seen.add(listed.cursor); cursor = listed.cursor;
  }
  throw new Error('image_retention_scan_limit');
}
