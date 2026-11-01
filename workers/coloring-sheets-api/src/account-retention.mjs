// Anonymous accounts, with their generation records, reports and safety state,
// are deleted after 180 days without an authenticated request. Each Account DO
// keeps its own last-activity time and alarm, so no account directory is needed.
export const INACTIVITY_MS = 180 * 86400000;
const ACTIVITY_KEY = 'activity';
// Writing on every request would add a storage write to each call; a day of
// imprecision is immaterial against a 180-day window.
const WRITE_INTERVAL_MS = 86400000;

async function scheduleBy(storage, when) {
  const previous = await storage.getAlarm?.();
  if (!previous || previous > when) await storage.setAlarm(when);
}

export async function recordActivity(storage, now = Date.now()) {
  const previous = await storage.get(ACTIVITY_KEY);
  if (previous && now - previous.lastActiveAt < WRITE_INTERVAL_MS) return;
  await storage.put(ACTIVITY_KEY, {lastActiveAt: now});
  await scheduleBy(storage, now + INACTIVITY_MS);
}

// Accounts created before retention existed have no record. Start their
// window now rather than guessing an earlier activity time.
export async function ensureActivityRecord(storage, now = Date.now()) {
  if (await storage.get(ACTIVITY_KEY)) return false;
  await storage.put(ACTIVITY_KEY, {lastActiveAt: now});
  await scheduleBy(storage, now + INACTIVITY_MS);
  return true;
}

// Returns true when the account has been inactive for the full window.
// Otherwise re-arms the alarm, which other work may have replaced.
export async function inactivityDue(storage, now = Date.now()) {
  await ensureActivityRecord(storage, now);
  const {lastActiveAt} = await storage.get(ACTIVITY_KEY);
  const due = lastActiveAt + INACTIVITY_MS;
  if (due <= now) return true;
  await scheduleBy(storage, due);
  return false;
}

// Budget claims are keyed claim:<accountId>:<generationId>. They are the only
// existing record of which accounts have generated, so the one-time backfill
// pages through them to give older accounts an activity record.
export async function retentionBackfillPage(storage, limit = 1000) {
  const state = await storage.get('retention-backfill') ?? {complete: false, cursor: null};
  if (state.complete) return {accountIds: [], complete: true};
  const entries = await storage.list({prefix: 'claim:', limit, ...(state.cursor ? {startAfter: state.cursor} : {})});
  const accountIds = [...new Set([...entries.keys()].map(key => key.split(':')[1]).filter(Boolean))];
  const complete = entries.size < limit;
  await storage.put('retention-backfill', {complete, cursor: complete ? null : [...entries.keys()].at(-1)});
  return {accountIds, complete};
}
