import {isUUID} from './composition.mjs';
import {ADMIN_EMAIL} from '../../shared/admin-identity.mjs';

export const DAY = 86400000;
export const REJECTION_LIMIT = 20;
const HISTORY_RETENTION = 90 * DAY;
const key = 'account-safety';
const empty = () => ({version: 0, epoch: 0, rejections: [], history: [], suspension: null});
export const activeSuspension = (value, now = Date.now()) => value && (value.until === null || value.until > now) ? value : null;
export function suspensionError(suspension) {
  return {error: {code: 'account_suspended', message: suspension.until === null
    ? 'Generation has been suspended for this account. Contact support for review.'
    : `Generation is suspended until ${new Date(suspension.until).toLocaleString('en-GB', {timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'})} UTC. Contact support for review.`,
  suspendedUntil: suspension.until === null ? null : new Date(suspension.until).toISOString()}};
}
const prune = (state, now) => {
  state.rejections = state.rejections.filter(entry => entry.at > now - DAY);
  if (state.suspension && !activeSuspension(state.suspension, now)) state.suspension = null;
  state.history = state.history.filter(entry => entry.at > now - HISTORY_RETENTION).slice(-50);
  return state;
};
const snapshot = (state, now) => ({version: state.version, epoch: state.epoch,
  rejectionCount: state.rejections.filter(entry => entry.epoch === state.epoch && entry.at > now - DAY).length,
  threshold: REJECTION_LIMIT, windowHours: 24, suspension: activeSuspension(state.suspension, now), history: state.history});

// The account is authoritative. Directory delivery uses a durable outbox, so an
// index outage cannot undo enforcement or hide a suspension permanently.
export class AccountSafety {
  constructor(storage) { this.storage = storage; }
  async read() { const now = Date.now(); return snapshot(prune((await this.storage.get(key)) ?? empty(), now), now); }
  async bindingMatches(id, fingerprint) {
    const state = await this.storage.get(key);
    const previous = state?.rejections.find(entry => entry.id === id && entry.at > Date.now() - DAY);
    return !previous?.fingerprint || previous.fingerprint === fingerprint;
  }
  async gate() { const state = await this.read(); return state.suspension ? suspensionError(state.suspension) : null; }
  async schedule(storage, when) {
    const previous = await storage.getAlarm?.();
    if (!previous || previous > when) await storage.setAlarm(when);
  }
  async publish(storage, state, now) {
    state.pendingDirectory = {version: state.version, suspension: activeSuspension(state.suspension, now), updatedAt: now};
    await storage.put(key, state);
    await this.schedule(storage, now + 1000);
  }
  async reject(id, error, epoch, fingerprint) {
    if (!isUUID(id) || error?.code !== 'description_not_suitable' || error.status !== 400 ||
        !error.reasonCodes?.some(reason => ['sexual', 'violence', 'hate', 'adult', 'frightening', 'bypass'].includes(reason))) return;
    return this.storage.transaction(async storage => {
      const now = Date.now(), state = prune((await storage.get(key)) ?? empty(), now);
      if (epoch !== state.epoch || activeSuspension(state.suspension, now) || state.rejections.some(entry => entry.id === id)) return;
      state.rejections.push({id, at: now, epoch, ...(fingerprint ? {fingerprint} : {})});
      // Only 20 strikes can arrive before suspension. Keep recent receipts from
      // reinstated epochs too, preventing cached/retried batches adding strikes.
      state.rejections = state.rejections.slice(-1000);
      state.version++;
      if (snapshot(state, now).rejectionCount >= REJECTION_LIMIT) {
        state.suspension = {source: 'automatic', reason: '20 content-policy rejections in 24 hours', at: now, until: now + DAY};
        state.history.push({id: crypto.randomUUID(), action: 'automatic_suspend', at: now, until: now + DAY, reason: state.suspension.reason, actor: null});
        await this.publish(storage, state, now);
      } else {
        await storage.put(key, state);
        await this.schedule(storage, Math.min(...state.rejections.map(entry => entry.at)) + DAY);
      }
    });
  }
  async change(input) {
    const {actor, action, reason, durationHours, requestId, expectedVersion} = input;
    if (actor?.email !== ADMIN_EMAIL || typeof actor.id !== 'string' || !actor.id || actor.id.length > 255) return {status: 403, value: {error: {code: 'forbidden', message: 'Operator access required.'}}};
    if (!['suspend', 'reinstate'].includes(action) || typeof reason !== 'string' || !reason.trim() || reason.length > 300 ||
        /[\u0000-\u001f\u007f]/.test(reason) || !isUUID(requestId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        action === 'suspend' && ![24, 168, null].includes(durationHours)) return {status: 400, value: {error: {code: 'invalid_request', message: 'Choose an action, duration and a reason (up to 300 characters).'}}};
    return this.storage.transaction(async storage => {
      const now = Date.now(), state = prune((await storage.get(key)) ?? empty(), now);
      const request = {action, reason: reason.trim(), durationHours: action === 'suspend' ? durationHours : null, expectedVersion, actor: {id: actor.id, email: actor.email}};
      const previous = state.history.find(entry => entry.id === requestId);
      if (previous && JSON.stringify(previous.request) === JSON.stringify(request)) return {status: 200, value: {...snapshot(state, now), operation: previous}};
      if (previous || state.version !== expectedVersion) return {status: 409, value: {error: {code: 'safety_conflict', message: 'The account changed. Refresh it before making another change.'}}};
      const until = action === 'suspend' && durationHours !== null ? now + durationHours * 3600000 : null;
      state.version++;
      state.suspension = action === 'suspend' ? {source: 'operator', reason: request.reason, at: now, until, actor: request.actor} : null;
      // Reinstatement gives a fresh strike allowance without forgetting retry IDs.
      if (action === 'reinstate') state.epoch++;
      const operation = {id: requestId, action, reason: request.reason, at: now, until, actor: request.actor, request};
      state.history.push(operation); state.history = state.history.slice(-50);
      await this.publish(storage, state, now);
      return {status: 200, value: {...snapshot(state, now), operation}};
    });
  }
  async maintain(deliver) {
    const state = await this.storage.get(key);
    if (!state) return;
    if (state.pendingDirectory) {
      await deliver(state.pendingDirectory);
      await this.storage.transaction(async storage => {
        const current = await storage.get(key);
        if (current?.pendingDirectory?.version === state.pendingDirectory.version) {
          delete current.pendingDirectory; await storage.put(key, current);
        }
      });
    }
    await this.storage.transaction(async storage => {
      const current = await storage.get(key); if (!current) return;
      const now = Date.now(); prune(current, now); await storage.put(key, current);
      const deadlines = [...current.rejections.map(entry => entry.at + DAY), ...current.history.map(entry => entry.at + HISTORY_RETENTION)];
      if (current.pendingDirectory) deadlines.push(now + 5000);
      if (deadlines.length) await this.schedule(storage, Math.min(...deadlines));
    });
  }
}

// Runs in the existing serialized Budget DO. Listing is a bounded index read;
// account lookup and changes always read the authoritative Account DO.
export async function safetyDirectory(storage, path, input) {
  const now = Date.now();
  if (path === '/safety-index') {
    if (!isUUID(input?.accountId) || !Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.updatedAt)) return Response.json({error: 'Invalid index update'}, {status: 400});
    const name = 'suspension:' + input.accountId, previous = await storage.get(name);
    if (!previous || input.version > previous.version) await storage.put(name, input);
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm > now + DAY) await storage.setAlarm(now + DAY);
    return Response.json({recorded: true});
  }
  if (input?.cursor !== undefined && !isUUID(input.cursor)) return Response.json({error: {code: 'invalid_request', message: 'Invalid cursor.'}}, {status: 400});
  const entries = await storage.list({prefix: 'suspension:', limit: 50, ...(input?.cursor ? {startAfter: 'suspension:' + input.cursor} : {})});
  return Response.json({accounts: [...entries.values()].filter(entry => activeSuspension(entry.suspension, now)),
    nextCursor: entries.size === 50 ? [...entries.keys()].at(-1).slice('suspension:'.length) : null});
}
export async function cleanSafetyDirectory(storage) {
  let cursor;
  await storage.setAlarm(Date.now() + 60000);
  for (;;) {
    const entries = await storage.list({prefix: 'suspension:', limit: 1000, ...(cursor ? {startAfter: cursor} : {})});
    for (const [name, entry] of entries) if (!activeSuspension(entry.suspension) && entry.updatedAt < Date.now() - DAY) await storage.delete(name);
    if (entries.size < 1000) break;
    cursor = [...entries.keys()].at(-1);
  }
  if ((await storage.list({prefix: 'suspension:', limit: 1})).size) await storage.setAlarm(Date.now() + DAY);
  else await storage.deleteAlarm();
}
