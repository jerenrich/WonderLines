// Public v1 API. An account is a random UUID; no sign-in or personal profile exists.
import {modelCatalog, imageRequest, runImageRequest, ImageProviderError, submitFalRequest, pollFalRequest, falBillableUnits, validateFalConfiguration, falQueueURL} from './image-provider.mjs';
import {imageCost, refreshImageCostMetrics} from './image-cost.mjs';
export {ComparisonImageRunner} from './comparison-image-runner.mjs';
import {cleanLegacyUsageLogs} from './diagnostic-retention.mjs';
import {falCostData} from './fal-cost.mjs';
import {isUUID} from './composition.mjs';
import {prepareGeneration, startGeneration} from './generation-start.mjs';
import {moderateSubject, ModerationError, moderationModel, MODERATION_POLICY} from './moderation.mjs';
import {verifyAttestation, verifyAssertion, acceptCounter, fromB64url, b64url} from './app-attest.mjs';
import {readBoundedBody, RequestBodyTooLarge} from '../../shared/request-body.mjs';
const TOKEN_SECONDS = 2592000, encoder = new TextEncoder();
const DAILY_IMAGE_LIMIT = 100;
const COMPARISON_DAILY_IMAGE_LIMIT = DAILY_IMAGE_LIMIT * 10;
const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}});
const fail = (code, message, status, details = {}) => reply({error: {code, message, ...details}}, status);
// This is a dashboard-managed Worker variable, not source configuration. Invalid
// or absent values fail closed instead of risking spend.
function globalDailyGenerationLimit(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,5})$/.test(value)) return null;
  const limit = Number(value); return limit <= 100000 ? limit : null;
}
function freeDailyAllowance(env) {
  const value = Number(env.FREE_DAILY_ALLOWANCE ?? DAILY_IMAGE_LIMIT);
  return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? Math.min(value, DAILY_IMAGE_LIMIT) : 0;
}
function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64(s) { return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
let cachedHMAC;
async function key(secret) {
  if (cachedHMAC?.secret !== secret) cachedHMAC = {secret, promise: crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify'])};
  return cachedHMAC.promise;
}
async function token(sub, cid, secret) { const body = b64(encoder.encode(JSON.stringify({v: 1, sub, cid, exp: Math.floor(Date.now() / 1000) + TOKEN_SECONDS}))); return body + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body)))); }
async function claims(header, secret, allowExpired = false) {
  if (!header?.startsWith('Bearer ') || !secret) return null;
  const [body, signature, extra] = header.slice(7).split('.'); if (!body || !signature || extra) return null;
  try { const value = JSON.parse(new TextDecoder().decode(unb64(body))); return await crypto.subtle.verify('HMAC', await key(secret), unb64(signature), encoder.encode(body)) && value.v === 1 && /^[0-9a-f-]{36}$/.test(value.sub) && /^[0-9a-f-]{36}$/.test(value.cid) && Number.isSafeInteger(value.exp) && (allowExpired || value.exp > Date.now() / 1000) ? value : null; } catch { return null; }
}
async function body(request, max = 4096, raw) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return null;
  const bytes = raw ?? await readBoundedBody(request, max);
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { return null; }
}
async function digest(value) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function register(request, env) {
  if (request.method !== 'POST') return fail('invalid_request', 'Send an empty JSON object.', 400);
  // CF-Connecting-IP is set by Cloudflare. Never trust client forwarding headers.
  const address = request.headers.get('CF-Connecting-IP');
  if (!address || !env.REGISTRATION_LIMITER) return fail('service_unavailable', 'Registration protection is unavailable.', 503);
  try {
    const hash = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.ACCOUNT_TOKEN_SECRET), encoder.encode('registration:' + address))));
    if (!(await env.REGISTRATION_LIMITER.limit({key: hash})).success) {
      return reply({error: {code: 'registration_rate_limited', message: 'Too many registrations. Please try again in a minute.'}}, 429, {'Retry-After': '60'});
    }
  } catch { return fail('service_unavailable', 'Registration protection is unavailable.', 503); }
  const input = await body(request);
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) return fail('invalid_request', 'Send an empty JSON object.', 400);
  // The shared ledger supplies a strict global cap even across network addresses
  // and Cloudflare locations. Reserve before creating any persistent account.
  let allowed;
  try {
    const ledger = env.BUDGET.get(env.BUDGET.idFromName('daily-generation-budget'));
    allowed = await ledger.fetch('https://budget/register', {method: 'POST', body: '{}'});
  } catch { return fail('service_unavailable', 'Registration protection is unavailable.', 503); }
  if (!allowed.ok) return allowed;
  const id = crypto.randomUUID(), made = await call(env, id, '/initialize', {accountId: id});
  if (made.status !== 201) return fail('service_unavailable', 'Could not create an anonymous account.', 503);
  return reply({accountId: id, accessToken: await token(id, made.value.credentialId, env.ACCOUNT_TOKEN_SECRET), expiresAt: Math.floor(Date.now() / 1000) + TOKEN_SECONDS, access: made.value.access}, 201);
}
// The challenge is self-contained and MACed, so issuing one costs no DO write.
// Assertion counters in the account DO supply the one-time replay guarantee.
async function challenge(accountID, purpose, secret) {
  const data = b64(encoder.encode(JSON.stringify({v: 1, accountID, purpose, expires: Date.now() + 300000, nonce: b64(crypto.getRandomValues(new Uint8Array(32)))})));
  return data + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode('app-attest:' + data))));
}
async function challengeValid(value, accountID, purpose, secret) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const [data, mac, extra] = value.split('.'); if (!data || !mac || extra) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64(data)));
    return payload.v === 1 && payload.accountID === accountID && payload.purpose === purpose &&
      Number.isSafeInteger(payload.expires) && payload.expires > Date.now() && payload.expires <= Date.now() + 300000 &&
      typeof payload.nonce === 'string' && payload.nonce.length === 43 &&
      await crypto.subtle.verify('HMAC', await key(secret), unb64(mac), encoder.encode('app-attest:' + data));
  } catch { return false; }
}
function appAttestConfigured(env) {
  return /^[A-Z0-9]{10}\.com\.jordan\.family\.ColoringSheets$/.test(env.APP_ATTEST_APP_ID ?? '') &&
    ['development', 'production'].includes(env.APP_ATTEST_ENVIRONMENT);
}

function stub(env, id) { return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id)); }
async function call(env, id, path, input) { const response = await stub(env, id).fetch('https://account' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)}); return {status: response.status, value: await response.json()}; }
async function reserveGlobalBudget(env, claim, provider) {
  const object = env.BUDGET.get(env.BUDGET.idFromName('daily-generation-budget'));
  const response = await object.fetch('https://budget/reserve', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({claim, provider})});
  return {status: response.status, value: await response.json()};
}
const accessHeader = access => encodeURIComponent(JSON.stringify(access));

// This second DO caps total daily spend even if an attacker repeatedly registers
// fresh anonymous installations.
export class Budget {
  constructor(state, env) { this.state = state; this.env = env; this.reservations = Promise.resolve(); }
  fetch(request) {
    const reservation = this.reservations.then(() => this.reserve(request));
    this.reservations = reservation.catch(() => {});
    return reservation;
  }
  async reserve(request) {
    const input = await request.json().catch(() => null);
    if (new URL(request.url).pathname === '/register') {
      const day = new Date().toISOString().slice(0, 10), existing = await this.state.storage.get('registrations');
      const used = existing?.day === day ? existing.used : 0;
      const limit = globalDailyGenerationLimit(this.env.GLOBAL_DAILY_REGISTRATION_LIMIT ?? '1000');
      if (limit === null) return fail('service_unavailable', 'The registration limit is not configured correctly.', 503);
      if (used >= limit) {
        const retry = Math.max(1, Math.ceil((Date.parse(day + 'T00:00:00Z') + 86400000 - Date.now()) / 1000));
        return reply({error: {code: 'registration_rate_limited', message: 'New registrations are temporarily unavailable. Please try again later.'}}, 429, {'Retry-After': String(retry)});
      }
      await this.state.storage.put('registrations', {day, used: used + 1});
      return reply({reserved: true}, 201);
    }
    if (new URL(request.url).pathname === '/forget-account' && isUUID(input?.accountId)) {
      const entries = await this.state.storage.list({prefix: 'claim:' + input.accountId + ':'});
      for (const key of entries.keys()) await this.state.storage.delete(key);
      // Keep aggregate daily spend counters, without the deleted account IDs.
      return reply({deleted: true});
    }
    if (new URL(request.url).pathname !== '/reserve' || typeof input?.claim !== 'string') return fail('invalid_request', 'Invalid budget reservation.', 400);
    if (await this.state.storage.get('claim:' + input.claim)) return reply({reserved: true});
    const day = new Date().toISOString().slice(0, 10), existing = await this.state.storage.get('usage');
    const used = existing?.day === day ? existing.used : 0, limit = globalDailyGenerationLimit(this.env.GLOBAL_DAILY_GENERATION_LIMIT);
    if (limit === null) return fail('service_unavailable', 'The service budget is not configured.', 503);
    if (used >= limit) return fail('global_budget_exhausted', 'The service is unavailable today.', 429);
    if (input.provider === 'fal') {
      const falLimit = globalDailyGenerationLimit(this.env.FAL_DAILY_GENERATION_LIMIT);
      const usage = await this.state.storage.get('fal-usage');
      const falUsed = usage?.day === day ? usage.used : 0;
      if (falLimit === null) return fail('service_unavailable', 'The fal trial limit is not configured.', 503);
      if (falUsed >= falLimit) return fail('service_budget_exhausted', 'This model’s daily service limit has been reached. Choose another model.', 429);
      await this.state.storage.put('fal-usage', {day, used: falUsed + 1});
    }
    await this.state.storage.put('usage', {day, used: used + 1});
    await this.state.storage.put('claim:' + input.claim, true);
    return reply({reserved: true}, 201);
  }
}

// One DO per anonymous account makes allowance reservation and credit deduction atomic.
export class Account {
  constructor(state, env) { this.state = state; this.env = env; this.reservations = Promise.resolve(); this.attestUpdates = Promise.resolve(); this.moderationUpdates = Promise.resolve(); this.usageUpdates = new Map(); this.activeOperations = new Set(); this.deletionWork = null; this.comparisonAdmissions = Promise.resolve(); }
  track(operation) {
    const pending = Promise.resolve().then(operation);
    this.activeOperations.add(pending);
    pending.then(() => this.activeOperations.delete(pending), () => this.activeOperations.delete(pending));
    return pending;
  }
  fetch(request) {
    if (new URL(request.url).pathname === '/delete') return this.deleteAccount(request);
    return this.track(async () => {
      if (await this.state.storage.get('deletion')) return fail('account_deleted', 'This account has been deleted.', 410);
      return this.handleRequest(request);
    });
  }
  async handleRequest(request) {
    const input = await request.json().catch(() => null), path = new URL(request.url).pathname;
    if (!input || request.method !== 'POST') return fail('invalid_request', 'Send JSON.', 400);
    if (path === '/initialize') return this.initialize(input);
    const account = await this.state.storage.get('account');
    if (!account) return fail('unknown_account', 'Unknown account.', 404);
    if (path === '/authorize') return account.credentialId === input.credentialId ? reply({access: await this.access(), appAttested: !!account.appAttested}) : fail('invalid_token', 'Invalid token.', 401);
    if (path === '/attest-status') {
      const enrolled = await this.state.storage.get('app-attest');
      return reply({keyID: enrolled?.keyID ?? null});
    }
    if (path === '/attest') {
      const update = this.attestUpdates.then(() => this.registerAttestation(input));
      this.attestUpdates = update.catch(() => {});
      return update;
    }
    if (path === '/assertion') {
      const update = this.attestUpdates.then(() => this.assertion(input));
      this.attestUpdates = update.catch(() => {});
      return update;
    }
    if (path === '/moderate-batch') {
      const decision = this.moderationUpdates.then(() => this.moderateBatch(input));
      this.moderationUpdates = decision.catch(() => {});
      return decision;
    }
    if (path === '/reserve') {
      // The global budget call yields to other requests. Keep account reservations
      // in order so a parallel batch cannot read and spend the same allowance.
      const reservation = this.reservations.then(() => this.reserve(input));
      this.reservations = reservation.catch(() => {});
      return reservation;
    }
    if (path === '/report') return this.report(input);
    if (path === '/store-result') return this.storeResult(input);
    if (path === '/job') return this.job(input);
    if (path === '/usage') return this.usage(input);
    if (path === '/complete') return this.complete(input);
    if (path === '/access') return reply({access: await this.access()});
    return fail('not_found', 'Not found.', 404);
  }
  async deleteAccount(request) {
    const input = await request.json().catch(() => null);
    if (request.method !== 'POST' || !isUUID(input?.accountId) || !isUUID(input?.credentialId)) return fail('invalid_request', 'Invalid deletion request.', 400);
    const credentialHash = await digest(input.credentialId);
    const previous = await this.state.storage.get('deletion');
    const account = await this.state.storage.get('account');
    if (previous ? previous.credentialHash !== credentialHash : account && account.credentialId !== input.credentialId) {
      return fail('unauthorized', 'Invalid account credential.', 401);
    }
    // Only the public route with a valid signed (possibly expired) credential can
    // call this. An absent record is an idempotently completed deletion.
    if (!previous && !account) return reply({deleted: true});
    if (!previous) {
      await this.state.storage.put('deletion', {accountId: input.accountId, credentialHash, startedAt: Date.now(), complete: false});
      await this.state.storage.setAlarm(Date.now() + 1000);
    }
    try { await this.finishDeletion(); return reply({deleted: true}); }
    catch { return fail('deletion_pending', 'Deletion is still pending. Please retry.', 503); }
  }
  async finishDeletion() {
    if (this.deletionWork) return this.deletionWork;
    const work = (async () => {
      let marker = await this.state.storage.get('deletion');
      if (!marker) return;
      // Any operation that passed the gate before deletion must finish before
      // cleanup. New operations fail closed. Include provider and billing awaits.
      await Promise.allSettled([...this.activeOperations]);
      await this.state.storage.setAlarm(Date.now() + 60000);
      for (const prefix of [marker.accountId + '/', 'reports/' + marker.accountId + '/']) {
        for (;;) {
          const page = await this.env.GENERATIONS.list({prefix, limit: 1000});
          if (!page.objects.length) break;
          await this.env.GENERATIONS.delete(page.objects.map(object => object.key));
        }
      }
      const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName('daily-generation-budget'));
      const forgotten = await budget.fetch('https://budget/forget-account', {method: 'POST', body: JSON.stringify({accountId: marker.accountId})});
      if (!forgotten.ok) throw new Error('Account cleanup pending');
      marker = {...marker, complete: true};
      // Keep only a short-lived deletion marker to reject late work and sweep
      // writes from older Worker deployments. No prompts, keys or images remain.
      for (;;) {
        const entries = await this.state.storage.list({limit: 1000});
        const keys = [...entries.keys()].filter(key => key !== 'deletion');
        if (!keys.length) break;
        await this.state.storage.delete(keys);
      }
      if (Date.now() - marker.startedAt < 86400000) {
        await this.state.storage.put('deletion', marker);
        await this.state.storage.setAlarm(Date.now() + 3600000);
      } else {
        await this.state.storage.delete('deletion');
        await this.state.storage.deleteAlarm();
      }
    })();
    this.deletionWork = work;
    try { await work; } finally { this.deletionWork = null; }
  }
  async report({generationId, reason}) {
    if (!isUUID(generationId) || !['sexual', 'violence', 'hate', 'other'].includes(reason)) return fail('invalid_request', 'Choose a report reason.', 400);
    const job = await this.state.storage.get('job:' + generationId);
    if (!job || job.state !== 'completed') return fail('not_found', 'Saved sheet not found.', 404);
    if (job.reported) return reply({reported: true});
    const account = await this.state.storage.get('account');
    const report = {accountId: account.id, generationId, reason, reportedAt: new Date().toISOString(),
      objectKey: job.objectKey, model: job.metrics?.requestedModel ?? null, status: 'pending'};
    // A durable queue in the existing private bucket; support reviews it using
    // the documented report-review procedure. No mail app is required to report.
    try {
      await this.env.GENERATIONS.put('reports/' + account.id + '/' + generationId + '.json', JSON.stringify(report),
        {httpMetadata: {contentType: 'application/json'}});
      await this.state.storage.transaction(async storage => {
        const current = await storage.get('job:' + generationId);
        if (!current) throw new Error('Report record unavailable');
        await storage.put('job:' + generationId, {...current, reported: true});
      });
    } catch { return fail('report_unavailable', 'The report could not be confirmed. Please retry.', 503); }
    console.info(JSON.stringify({event: 'sheet_report_received', generationID: generationId, reason}));
    return reply({reported: true}, 201);
  }
  async storeResult({generationId, image, metrics}) {
    const job = await this.state.storage.get('job:' + generationId);
    if (!job || job.state !== 'processing') return fail('not_found', 'Generation not found.', 404);
    const account = await this.state.storage.get('account');
    const objectKey = account.id + '/' + generationId + '.png';
    await this.env.GENERATIONS.put(objectKey, unb64(image), {httpMetadata: {contentType: 'image/png'}});
    return this.complete({generationId, result: {state: 'completed', objectKey, metrics}});
  }
  async moderateBatch({batchID, description}) {
    if (!isUUID(batchID) || typeof description !== 'string' || !description.trim() || description.length > 500) return fail('invalid_request', 'Invalid batch.', 400);
    const fingerprint = await digest(JSON.stringify({batchID, description, policy: MODERATION_POLICY, model: this.env.MODERATION_MODEL ?? 'clef'}));
    const name = 'moderation:' + batchID;
    const previous = await this.state.storage.get(name);
    if (previous && previous.expires > Date.now()) {
      if (previous.fingerprint !== fingerprint) return fail('batch_conflict', 'This batch uses a different description.', 409);
      return previous.error ? fail(previous.error.code, previous.error.message, previous.error.status, {reasonCodes: previous.error.reasonCodes}) : reply({approved: true});
    }
    // Retain only opaque fingerprints and fixed outcomes, never user text or
    // model scores. Bound storage and expire decisions after ten minutes.
    const entries = await this.state.storage.list({prefix: 'moderation:'});
    const current = [...entries].filter(([, value]) => value.expires > Date.now());
    for (const [key, value] of entries) if (value.expires <= Date.now()) await this.state.storage.delete(key);
    if (current.length >= 64) {
      console.info(JSON.stringify({event: 'description_moderation', batchID, model: moderationModelForLog(this.env),
        policy: MODERATION_POLICY, outcome: 'moderation_unavailable', failure: 'batch_limit'}));
      return fail('moderation_unavailable', 'The description safety check is temporarily unavailable. No sheet allowance was used. Please try again later.', 503);
    }
    let error, diagnostics;
    try { diagnostics = await moderateSubject(this.env, description); }
    catch (caught) {
      if (!(caught instanceof ModerationError)) throw caught;
      diagnostics = caught.diagnostics;
      error = {code: caught.code, message: caught.message, status: caught.status, reasonCodes: caught.reasonCodes};
    }
    await this.state.storage.put(name, {fingerprint, expires: Date.now() + 600000, ...(error ? {error} : {})});
    console.info(JSON.stringify({event: 'description_moderation', batchID, model: moderationModelForLog(this.env),
      policy: MODERATION_POLICY, outcome: error?.code ?? 'approved', ...diagnostics, reasonCodes: error?.reasonCodes ?? []}));
    return error ? fail(error.code, error.message, error.status, {reasonCodes: error.reasonCodes}) : reply({approved: true});
  }
  async registerAttestation(input) {
    if (typeof input.keyID !== 'string' || typeof input.publicKey !== 'string' || input.publicKey.length > 1024) return fail('invalid_request', 'Invalid attestation.', 400);
    const previous = await this.state.storage.get('app-attest');
    const account = await this.state.storage.get('account');
    // The public route verifies a fresh Apple attestation and an account-bound
    // challenge before reaching this method. Reinstall/restore can legitimately
    // replace the device key; retain the account, quota, and generation history.
    const replacement = !previous || previous.keyID !== input.keyID;
    if (replacement || !account.appAttested) {
      await this.state.storage.transaction(async storage => {
        if (replacement) await storage.put('app-attest', {keyID: input.keyID, publicKey: input.publicKey, counter: 0, seen: '0'});
        if (!account.appAttested) await storage.put('account', {...account, appAttested: true});
      });
    }
    return reply({attested: true});
  }
  async assertion({assertion, clientData, generationID}) {
    const record = await this.state.storage.get('app-attest');
    if (!record) {
      logAttestRejection('Enrollment required', generationID);
      return fail('app_attest_required', 'This installation needs App Attest enrollment.', 403);
    }
    try {
      const counter = verifyAssertion(assertion, fromB64url(clientData, 2048), record.publicKey, this.env.APP_ATTEST_APP_ID);
      await this.state.storage.put('app-attest', acceptCounter(record, counter));
      return reply({verified: true});
    } catch (error) {
      // Only known verifier labels: never log the assertion, client data, key,
      // arbitrary exception messages, or request headers.
      const labels = ['Invalid encoding', 'Invalid CBOR', 'Invalid assertion', 'Invalid assertion extensions',
        'Invalid RP ID', 'Invalid App ID', 'Invalid assertion counter', 'Invalid assertion signature', 'Replayed assertion'];
      logAttestRejection(labels.includes(error?.message) ? error.message : 'Verification unavailable', generationID);
      return fail('invalid_assertion', 'App Attest assertion could not be verified.', 403);
    }
  }
  async initialize({accountId}) {
    if (!/^[0-9a-f-]{36}$/.test(accountId) || await this.state.storage.get('account')) return fail('invalid_account', 'Invalid account.', 409);
    const account = {id: accountId, credentialId: crypto.randomUUID()}; await this.state.storage.put('account', account);
    return reply({credentialId: account.credentialId, access: await this.access()}, 201);
  }
  async dailyImagePolicy() {
    const account = await this.state.storage.get('account');
    if (account?.id && account.id === this.env.COMPARISON_ACCOUNT_ID) {
      return {limit: COMPARISON_DAILY_IMAGE_LIMIT, allowance: COMPARISON_DAILY_IMAGE_LIMIT};
    }
    return {limit: DAILY_IMAGE_LIMIT, allowance: freeDailyAllowance(this.env)};
  }
  async access() {
    const day = new Date().toISOString().slice(0, 10), {allowance} = await this.dailyImagePolicy();
    const usage = await this.state.storage.get('usage'), credits = (await this.state.storage.get('credits')) ?? 0;
    return {features: [], generationCredits: credits, freeGenerationsRemaining: Math.max(0, allowance - (usage?.day === day ? usage.used : 0)), allowanceResetsAt: new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString()};
  }
  async reserve({generationId, fingerprint, falTask, imageTask}) {
    if (!/^[0-9a-f-]{36}$/.test(generationId) || typeof fingerprint !== 'string') return fail('invalid_request', 'Invalid generation.', 400);
    const jobKey = 'job:' + generationId, existing = await this.state.storage.get(jobKey);
    if (existing) return existing.fingerprint === fingerprint ? reply({job: existing, access: await this.access()}) : fail('idempotency_conflict', 'Generation ID was already used.', 409);
    if (falTask) try {
      validateFalConfiguration(this.env);
      falQueueURL(falTask.request?.model);
    } catch { return fail('service_unavailable', 'Image provider configuration is incomplete.', 503); }
    const day = new Date().toISOString().slice(0, 10), {limit, allowance} = await this.dailyImagePolicy(), usage = await this.state.storage.get('usage');
    const used = usage?.day === day ? usage.used : 0; let credits = (await this.state.storage.get('credits')) ?? 0;
    if (used >= limit) return fail('allowance_exhausted', `Today’s limit of ${limit} images has been reached. It resets at midnight UTC.`, 429);
    if (used >= allowance && credits < 1) return fail('allowance_exhausted', 'Today’s free sheet allowance has been used.', 429);
    const global = await reserveGlobalBudget(this.env, (await this.state.storage.get('account')).id + ':' + generationId, falTask || imageTask?.route?.provider === 'fal' ? 'fal' : undefined);
    if (global.status === 429) return fail('service_budget_exhausted', global.value.error.message, 429);
    if (global.status >= 400) return fail('service_unavailable', 'Could not reserve service capacity.', 503);
    await this.state.storage.put('usage', {day, used: used + 1});
    if (used >= allowance) await this.state.storage.put('credits', --credits);
    const job = {id: generationId, fingerprint, state: 'processing', createdAt: Date.now(),
      ...(falTask ? {fal: {...falTask, stage: 'queued'}} : {}),
      ...(imageTask ? {imageTask: {...imageTask, stage: 'queued'}} : {})};
    if (falTask || imageTask) {
      // Job and alarm commit together; a disconnected POST cannot strand a queue submission.
      await this.state.storage.transaction(async storage => {
        await storage.put(jobKey, job);
        await storage.put((falTask ? 'fal:' : 'image:') + generationId, generationId);
        await storage.setAlarm(Date.now() + 1000);
      });
    } else await this.state.storage.put(jobKey, job);
    return reply({job, access: await this.access()}, 201);
  }
  async alarm() {
    await this.track(async () => {
      if (!await this.state.storage.get('deletion')) await this.runAlarm();
    });
    if (await this.state.storage.get('deletion')) await this.finishDeletion();
  }
  async runAlarm() {
    const pending = await this.state.storage.list({prefix: 'fal:', limit: 5});
    const account = await this.state.storage.get('account');
    const comparison = !!account?.id && account.id === this.env.COMPARISON_ACCOUNT_ID;
    const imageConcurrency = comparison ? 50 : 3;
    const images = comparison && this.env.COMPARISON_RUNNERS
      ? await this.comparisonSlots()
      : await this.state.storage.list({prefix: 'image:', limit: imageConcurrency});
    if (!pending.size && !images.size) return;
    // Schedule a watchdog before network IO. Alarm retries only poll recorded IDs;
    // they must never repeat an ambiguous submission after a crash.
    await this.state.storage.setAlarm(Date.now() + 30000);
    const outcomes = await Promise.allSettled([
      ...[...pending.values()].map(id => this.advanceFal(id)),
      ...[...images.values()].map(id => this.advanceImage(id))
    ]);
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('Queued generation persistence failed');
    if ((await this.state.storage.list({prefix: 'fal:', limit: 1})).size ||
        (await this.state.storage.list({prefix: 'image:', limit: 1})).size) {
      await this.state.storage.setAlarm(Date.now() + 5000);
    }
  }
  comparisonSlots() {
    const admission = this.comparisonAdmissions.then(async () => {
      const previous = (await this.state.storage.get('comparison-active')) ?? [];
      const active = [];
      for (const id of previous) if (await this.state.storage.get('image:' + id)) active.push(id);
      const queued = await this.state.storage.list({prefix:'image:',limit:150});
      for (const id of queued.values()) {
        if (active.length >= 50) break;
        if (!active.includes(id)) active.push(id);
      }
      // Keep explicit slots: newly arriving UUIDs must not displace an already
      // running task just because they sort earlier in the queue.
      await this.state.storage.put('comparison-active',active);
      return new Map(active.map(id=>['image:'+id,id]));
    });
    this.comparisonAdmissions=admission.catch(()=>{});return admission;
  }
  async advanceImage(id) {
    const job = await this.state.storage.get('job:' + id);
    if (!job || job.state !== 'processing') { await this.state.storage.delete('image:' + id); return; }
    const account = await this.state.storage.get('account');
    const objectKey = account.id + '/' + id + '.png';
    if (account.id === this.env.COMPARISON_ACCOUNT_ID && this.env.COMPARISON_RUNNERS && ['queued','delegated'].includes(job.imageTask.stage)) {
      // Return after a durable handoff. Each runner's own alarm performs one
      // inference, outside this account's shared outgoing-connection limit.
      if (job.imageTask.stage !== 'delegated') {
        job.imageTask.stage = 'delegated';
        await this.state.storage.put('job:' + id, job);
      }
      const runner = this.env.COMPARISON_RUNNERS.get(this.env.COMPARISON_RUNNERS.idFromName(account.id + ':' + id));
      const accepted = await runner.fetch('https://runner/start', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        id,accountId:account.id,fingerprint:job.fingerprint,createdAt:job.createdAt,
        route:job.imageTask.route,subject:job.imageTask.subject,size:job.imageTask.size,publicModel:job.imageTask.publicModel
      })});
      await accepted.body?.cancel();
      if (!accepted.ok) throw new Error('Comparison runner handoff failed');
      return;
    }
    const finishFailure = async (code, message) => {
      await this.complete({generationId: id, result: {state: 'failed', errorCode: code, message}});
      await this.state.storage.delete('image:' + id);
    };
    if (job.imageTask.stage !== 'queued') {
      // An alarm can run again after eviction/crash. Recover an already saved PNG,
      // but never repeat an ambiguous paid request.
      if (job.imageTask.stage === 'saving' && await this.env.GENERATIONS.get(objectKey)) {
        await this.complete({generationId: id, result: {state: 'completed', objectKey, metrics: job.metrics}});
        await this.state.storage.delete('image:' + id);
      } else {
        await finishFailure('provider_connection_failed', 'The image request was interrupted before its result was saved. You have not been charged. Check unfinished sheets before generating again.');
      }
      return;
    }
    let request;
    try { request = imageRequest(this.env, job.imageTask.route, job.imageTask.subject, job.imageTask.size); }
    catch {
      await finishFailure('provider_unavailable', 'Image provider configuration changed before the queued sheet could start. No provider request was sent.');
      return;
    }
    job.imageTask.stage = 'submitting';
    await this.state.storage.put('job:' + id, job);
    try {
      const result = await runImageRequest(request);
      const metrics = {requestedModel: job.imageTask.publicModel, provider: request.provider, upstreamModel: request.model,
        viaGateway: request.viaGateway, requestedSize: job.imageTask.size.width + 'x' + job.imageTask.size.height,
        size: result.size, inputTokens: result.inputTokens, textInputTokens: result.textInputTokens ?? null,
        imageInputTokens: result.imageInputTokens ?? null, cachedInputTokens: result.cachedInputTokens ?? null, outputTokens: result.outputTokens, totalTokens: result.totalTokens,
        elapsedMs: Date.now() - job.createdAt, ...imageCost(request, result)};
      job.imageTask.stage = 'saving';
      job.metrics = metrics;
      await this.state.storage.put('job:' + id, job);
      await this.env.GENERATIONS.put(objectKey, result.image, {httpMetadata: {contentType: 'image/png'}});
      await this.complete({generationId: id, result: {state: 'completed', objectKey, metrics}});
      await this.state.storage.delete('image:' + id);
    } catch (error) {
      if (job.imageTask.stage === 'saving') {
        // Keep the watchdog alive to check whether the R2 write committed.
        throw error;
      }
      await finishFailure(error instanceof ImageProviderError ? error.code : 'result_save_failed',
        error instanceof ImageProviderError ? error.message : 'The generated image could not be saved. You have not been charged.');
    }
  }
  async advanceFal(id) {
    const job = await this.state.storage.get('job:' + id);
    if (!job || job.state !== 'processing') { await this.state.storage.delete('fal:' + id); return; }
    const finishFailure = async (code, message) => {
      await this.complete({generationId: id, result: {state: 'failed', errorCode: code, message}});
      await this.state.storage.delete('fal:' + id);
    };
    if (Date.now() - job.createdAt > 30 * 60 * 1000) {
      await finishFailure('provider_timeout', 'The fal job could not be recovered within 30 minutes. You have not been charged. Check unfinished sheets before generating again.');
      return;
    }
    if (job.fal.stage === 'submitting') {
      await finishFailure('provider_connection_failed', 'The fal submission was interrupted before its job ID could be saved. You have not been charged. Check unfinished sheets before generating again.');
      return;
    }
    if (job.fal.stage === 'queued') {
      job.fal.stage = 'submitting';
      await this.state.storage.put('job:' + id, job);
      let requestID;
      try { requestID = await submitFalRequest(this.env, job.fal.request); }
      catch (error) {
        await finishFailure(error instanceof ImageProviderError ? error.code : 'provider_connection_failed',
          error instanceof ImageProviderError ? error.message : 'The fal submission could not be confirmed. You have not been charged.');
        return;
      }
      job.fal.requestID = requestID;
      job.fal.stage = 'polling';
      await this.state.storage.put('job:' + id, job);
      console.info(JSON.stringify({event: 'fal_submitted', generationID: id, providerRequestID: requestID,
        model: job.fal.request.model, requestedSize: job.fal.requestedSize, createdAt: job.createdAt}));
      return;
    }
    try {
      const result = await pollFalRequest(this.env, job.fal.requestID, job.fal.request.model);
      if (!result) return;
      const account = await this.state.storage.get('account');
      const objectKey = account.id + '/' + id + '.png';
      const metrics = {requestedModel: job.fal.publicModel, provider: 'fal', upstreamModel: job.fal.request.model,
        modelRevision: job.fal.request.modelRevision, seed: result.seed, inferenceMs: result.inferenceMs,
        billableUnits: result.billableUnits,
        viaGateway: true, requestedSize: job.fal.requestedSize, size: result.size,
        inputTokens: null, outputTokens: null, totalTokens: null,
        elapsedMs: Date.now() - job.createdAt, ...imageCost(job.fal.request, result)};
      await this.env.GENERATIONS.put(objectKey, result.image, {httpMetadata: {contentType: 'image/png'}});
      await this.complete({generationId: id, result: {state: 'completed', objectKey, metrics}});
      await this.state.storage.delete('fal:' + id);
    } catch (error) {
      // Read-only network, download and storage failures can safely be retried.
      if (error instanceof ImageProviderError && ['upstream_failed', 'provider_content_rejected',
          'provider_invalid_response', 'provider_request_rejected', 'provider_model_unavailable'].includes(error.code)) {
        await finishFailure(error.code, error.message);
      }
    }
  }
  async job({generationId}) {
    let job = await this.state.storage.get('job:' + generationId);
    if (job?.state === 'processing' && !job.fal && !job.imageTask && Date.now() - job.createdAt > 600000) {
      // Old synchronous requests cannot finish indefinitely after disconnection.
      await this.complete({generationId, result: {state: 'failed', errorCode: 'provider_timeout',
        message: 'This earlier request was interrupted before its image was saved. You have not been charged. Check unfinished sheets before generating again.'}});
      job = await this.state.storage.get('job:' + generationId);
    }
    if (job?.state === 'completed') job.metrics = refreshImageCostMetrics(job.metrics);
    return job ? reply({job, access: await this.access()}) : fail('not_found', 'Generation not found.', 404);
  }
  async recordFalUsage(job) {
    const request = job.fal.request;
    const costData = await falCostData(this.env, job.fal.requestID, job.metrics?.billableUnits, job.createdAt, request.model);
    // Current list prices must not retroactively reprice a saved request. A
    // matching billing event can replace its estimate; otherwise keep the rate
    // captured with the request, including when later lookups are unavailable.
    if (costData.reportedCostUsd == null && Number.isFinite(job.metrics?.unitPriceUsd) && job.metrics.unitPriceUsd >= 0 && job.metrics.billingUnit) {
      costData.unitPriceUsd = job.metrics.unitPriceUsd;
      costData.billingUnit = job.metrics.billingUnit;
      costData.unitPriceCheckedAt = job.metrics.unitPriceCheckedAt ?? job.metrics.costCheckedAt;
    } else costData.unitPriceCheckedAt = costData.costCheckedAt;
    job.metrics = {...job.metrics, provider: 'fal', upstreamModel: request.model,
      requestedModel: job.fal.publicModel, requestedSize: job.fal.requestedSize,
      modelRevision: request.modelRevision, ...costData, ...imageCost(request, {...job.metrics, ...costData}),
      imageCount: request.payload?.num_images ?? job.metrics?.imageCount ?? 1,
      inferenceSteps: request.payload?.num_inference_steps ?? job.metrics?.inferenceSteps ?? (request.model === 'fal-ai/z-image/turbo' ? 8 : 30)};
    const audit = {event: 'fal_usage', generationID: job.id, state: job.state, errorCode: job.errorCode ?? null,
      createdAt: job.createdAt, completedAt: job.completedAt, ...job.metrics};
    // Operational diagnostics belong in the native seven-day Workers log store.
    // The job already contains billing metrics; do not duplicate them forever in R2.
    console.info(JSON.stringify(audit));
  }
  async usage({generationId}) {
    let job = await this.state.storage.get('job:' + generationId);
    if (!job) return fail('not_found', 'Generation not found.', 404);
    if (job.fal && job.state !== 'processing' && job.metrics?.costStatus !== 'reported' &&
        (!job.metrics?.costCheckedAt || Date.now() - Date.parse(job.metrics.costCheckedAt) > 60000)) {
      job = await this.updateFalUsage(job, true);
    }
    return reply({generationId, status: job.state, metrics: job.state === 'completed' ? refreshImageCostMetrics(job.metrics) ?? null : job.metrics ?? null});
  }
  async updateFalUsage(job, refreshBillableUnits = false) {
    const existing = this.usageUpdates.get(job.id);
    if (existing) return existing;
    const update = (async () => {
      if (refreshBillableUnits && job.state === 'completed' && job.metrics?.billableUnits == null) {
        job.metrics = {...job.metrics, billableUnits: await falBillableUnits(this.env, job.fal.requestID, job.fal.request.model)};
      }
      await this.recordFalUsage(job);
      // Billing awaits yield to reporting. Merge only billing fields into the
      // current record so an older snapshot cannot undo a safety decision.
      return this.state.storage.transaction(async storage => {
        const current = await storage.get('job:' + job.id);
        if (!current) return job;
        current.metrics = {...current.metrics, ...job.metrics};
        if (current.fal?.request) delete current.fal.request.payload;
        await storage.put('job:' + job.id, current);
        return current;
      });
    })();
    this.usageUpdates.set(job.id, update);
    try { return await update; }
    finally { this.usageUpdates.delete(job.id); }
  }
  async complete({generationId, result}) {
    const k = 'job:' + generationId, job = await this.state.storage.get(k);
    if (!job || job.state !== 'processing') return fail('not_found', 'Generation not found.', 404);
    const comparisonImage = !!job.imageTask && !!this.env.COMPARISON_RUNNERS && (await this.state.storage.get('account'))?.id === this.env.COMPARISON_ACCOUNT_ID;
    Object.assign(job, result, {completedAt: Date.now()});
    // Publish the saved image before optional billing network lookups. Readers
    // must not keep receiving "processing" while pricing/billing services stall.
    const ready = structuredClone(job);
    if (ready.fal?.request) {
      ready.metrics = {...ready.metrics,
        imageCount: ready.fal.request.payload?.num_images ?? ready.metrics?.imageCount ?? 1,
        inferenceSteps: ready.fal.request.payload?.num_inference_steps ?? ready.metrics?.inferenceSteps ?? (ready.fal.request.model === 'fal-ai/z-image/turbo' ? 8 : 30)};
      delete ready.fal.request.payload;
    }
    if (ready.imageTask) delete ready.imageTask;
    await this.state.storage.put(k, ready);
    if (comparisonImage) {
      await this.state.storage.delete('image:' + generationId);
      await this.state.storage.setAlarm(Date.now() + 1);
    }
    // Completion and concurrent usage reads share one update, so a slow lookup
    // cannot overwrite newer billing metadata or duplicate external requests.
    if (ready.fal?.request) await this.updateFalUsage(ready);
    return reply({access: await this.access()});
  }
}

async function authenticate(request, env, allowExpired = false) { const c = await claims(request.headers.get('Authorization'), env.ACCOUNT_TOKEN_SECRET, allowExpired); if (!c) return null; const checked = await call(env, c.sub, '/authorize', {credentialId: c.cid}); return checked.status === 200 ? {id: c.sub, credentialId: c.cid, access: checked.value.access, appAttested: checked.value.appAttested} : null; }
async function saved(env, job, access) {
  if (job.state === 'completed') job.metrics = refreshImageCostMetrics(job.metrics);
  if (job.reported) return fail('sheet_reported', 'This sheet was reported and is no longer available for recovery.', 410);
  if (job.state === 'completed') { const image = await env.GENERATIONS.get(job.objectKey); if (!image) return fail('result_unavailable', 'Saved image is unavailable.', 410); return new Response(image.body, {headers: {'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Generation-ID': job.id, 'X-Generation-Metrics': encodeURIComponent(JSON.stringify(job.metrics)), 'X-Access-Snapshot': accessHeader(access)}}); }
  if (job.state === 'failed') return fail(job.errorCode ?? 'upstream_failed', job.message, 502);
  return reply({generationId: job.id, status: 'processing'}, 202, {'Retry-After': '5', 'X-Access-Snapshot': accessHeader(access)});
}
async function generate(request, env, account, raw) {
  const input = await body(request, 4096, raw), generationId = request.headers.get('Idempotency-Key');
  const prepared = await prepareGeneration(input,generationId,env);
  const reservation = await startGeneration(prepared,{
    env,call:(path,value)=>call(env,account.id,path,value),
    queueImages:request.headers.get('X-Coloring-API-Version')==='2',
    onModeration:event=>{
      if(event.structured)console.info(JSON.stringify({event:'moderation_gate',generationID:event.generationId,batchID:event.batchID,outcome:event.outcome,status:event.status}));
      else console.info(JSON.stringify({event:'description_moderation',generationID:event.generationId,model:moderationModelForLog(env),policy:MODERATION_POLICY,outcome:event.outcome,...event.diagnostics,reasonCodes:event.reasonCodes}));
    }
  });
  if(reservation.value?.error)return reply(reservation.value,reservation.status);
  const {job,access,upstreamRequest}=reservation;
  if(reservation.recovered||job.state!=='processing'||job.fal||job.imageTask)return saved(env,job,access);
  const {model,size}=prepared;
  try {
    const started = Date.now(), result = await runImageRequest(upstreamRequest);
    const {image, size: actualSize, inputTokens, textInputTokens, imageInputTokens, cachedInputTokens, outputTokens, totalTokens} = result;
    const objectKey = account.id + '/' + generationId + '.png';
    const metrics = {requestedModel: model, provider: upstreamRequest.provider, upstreamModel: upstreamRequest.model,
      viaGateway: upstreamRequest.viaGateway, requestedSize: size.width + 'x' + size.height, size: actualSize,
      inputTokens, textInputTokens: textInputTokens ?? null, imageInputTokens: imageInputTokens ?? null,
      cachedInputTokens: cachedInputTokens ?? null, outputTokens, totalTokens, elapsedMs: Date.now() - started, ...imageCost(upstreamRequest, result)};
    const completed = await call(env, account.id, '/store-result', {generationId, image: b64(new Uint8Array(image)), metrics});
    if (completed.status !== 200) return reply(completed.value, completed.status);
    return new Response(image, {headers: {'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Generation-ID': generationId, 'X-Generation-Metrics': encodeURIComponent(JSON.stringify(metrics)), 'X-Access-Snapshot': accessHeader(completed.value.access)}});
  } catch (error) {
    // A synchronous provider failure has no background work that can finish it.
    // Persist a terminal result so polling/retries never trigger another paid call.
    const message = error instanceof ImageProviderError ? error.message : 'The generated image could not be saved.';
    const errorCode = error instanceof ImageProviderError ? error.code : 'result_save_failed';
    await call(env, account.id, '/complete', {generationId, result: {state: 'failed', message, errorCode}});
    return fail(errorCode, message, 502);
  }
}

function logAttestRejection(reason, generationID) {
  console.warn(JSON.stringify({event: 'app_attest_rejected', reason,
    ...(typeof generationID === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generationID) ? {generationID} : {})}));
}
function bindingRejection(request) {
  logAttestRejection('Invalid request binding', request.headers.get('Idempotency-Key'));
  return fail('invalid_assertion', 'Invalid App Attest request binding.', 403);
}

export default {
  async scheduled(_event, env) {
    try { console.info(JSON.stringify(await cleanLegacyUsageLogs(env.GENERATIONS))); }
    catch {
      console.error(JSON.stringify({event: 'legacy_usage_log_retention_failed'}));
      throw new Error('legacy_usage_log_retention_failed');
    }
  },
  async fetch(request, env) {
    try { return await fetchRequest(request, env); }
    catch (error) {
      if (error instanceof RequestBodyTooLarge) return fail('request_too_large', 'The request body is too large.', 413);
      throw error;
    }
  }
};
async function fetchRequest(request, env) {
  const url = new URL(request.url);
  if (!env.ACCOUNT_TOKEN_SECRET) return fail('service_unavailable', 'Service configuration is incomplete.', 503);
  if (url.pathname === '/v1/installations') return register(request, env);
  if (url.pathname === '/v1/installations/renew') {
    if (request.method !== 'POST' || !await body(request)) return fail('invalid_request', 'Send an empty JSON object.', 400);
    // Only renewal accepts an expired signed credential. The account must still
    // exist and its credentialId must match, so revocation also blocks renewal.
    const account = await authenticate(request, env, true);
    if (!account) return fail('unauthorized', 'The saved account credential could not be renewed.', 401);
    return reply({accountId: account.id, accessToken: await token(account.id, account.credentialId, env.ACCOUNT_TOKEN_SECRET), expiresAt: Math.floor(Date.now() / 1000) + TOKEN_SECONDS, access: account.access});
  }
  if (url.pathname === '/v1/account' && request.method === 'DELETE') {
    const signed = await claims(request.headers.get('Authorization'), env.ACCOUNT_TOKEN_SECRET, true);
    if (!signed) return fail('unauthorized', 'A saved account credential is required.', 401);
    const deleted = await call(env, signed.sub, '/delete', {accountId: signed.sub, credentialId: signed.cid});
    return reply(deleted.value, deleted.status);
  }
  const account = await authenticate(request, env); if (!account) return fail('unauthorized', 'Register this app installation again.', 401);
  if (url.pathname === '/v1/app-attest/challenge' && request.method === 'POST') {
    if (!appAttestConfigured(env)) return fail('service_unavailable', 'App Attest is not configured.', 503);
    const input = await body(request);
    if (!['attestation', 'assertion'].includes(input?.purpose)) return fail('invalid_request', 'Invalid challenge purpose.', 400);
    return reply({challenge: await challenge(account.id, input.purpose, env.ACCOUNT_TOKEN_SECRET)});
  }
  if (url.pathname === '/v1/app-attest/status' && request.method === 'GET') {
    const status = await call(env, account.id, '/attest-status', {});
    return reply(status.value, status.status);
  }
  if (url.pathname === '/v1/app-attest/attest' && request.method === 'POST') {
    if (!appAttestConfigured(env)) return fail('service_unavailable', 'App Attest is not configured.', 503);
    const input = await body(request, 16384);
    if (!input || !await challengeValid(input.challenge, account.id, 'attestation', env.ACCOUNT_TOKEN_SECRET)) return fail('invalid_attestation', 'Invalid attestation challenge.', 403);
    try {
      const verified = verifyAttestation(input.attestation, input.keyID, input.challenge, env.APP_ATTEST_APP_ID, env.APP_ATTEST_ENVIRONMENT);
      const stored = await call(env, account.id, '/attest', verified);
      return reply(stored.value, stored.status);
    } catch { return fail('invalid_attestation', 'App Attest attestation could not be verified.', 403); }
  }

  if (url.pathname === '/v1/models' && request.method === 'GET') {
    try {
      const {defaultModel, routes} = modelCatalog(env);
      return reply({defaultModel, models: Object.entries(routes).map(([id, route]) => ({id, ...route}))});
    } catch { return fail('service_unavailable', 'Image model configuration is incomplete.', 503); }
  }
  if (url.pathname === '/v1/access' && request.method === 'GET') return reply({access: account.access});
  if (url.pathname === '/v1/generations' && request.method === 'POST') {
    const signed = request.headers.get('X-App-Attest-Assertion');
    if (env.APP_ATTEST_ENFORCE && !['true', 'false'].includes(env.APP_ATTEST_ENFORCE)) return fail('service_unavailable', 'App Attest policy is invalid.', 503);
    const raw = await readBoundedBody(request, 4096);
    if (signed || account.appAttested || env.APP_ATTEST_ENFORCE === 'true') {
      if (!appAttestConfigured(env)) return fail('service_unavailable', 'App Attest is not configured.', 503);
      const encoded = request.headers.get('X-App-Attest-Client-Data');
      let clientData;
      try {
        clientData = fromB64url(encoded, 2048);
        const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(clientData));
        if (parsed.method !== 'POST' || parsed.path !== '/v1/generations' ||
            parsed.idempotencyKey !== request.headers.get('Idempotency-Key') ||
            parsed.bodySHA256 !== b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))) ||
            !await challengeValid(parsed.challenge, account.id, 'assertion', env.ACCOUNT_TOKEN_SECRET)) {
          return bindingRejection(request);
        }
      } catch { return bindingRejection(request); }
      const checked = await call(env, account.id, '/assertion', {assertion: signed, clientData: encoded, generationID: request.headers.get('Idempotency-Key')});
      if (checked.status !== 200) return reply(checked.value, checked.status);
    }
    return generate(request, env, account, raw);
  }
  const reportMatch = /^\/v1\/generations\/([0-9a-f-]{36})\/report$/.exec(url.pathname);
  if (reportMatch && request.method === 'POST') {
    const input = await body(request);
    const report = await call(env, account.id, '/report', {generationId: reportMatch[1], reason: input?.reason});
    return reply(report.value, report.status);
  }
  const usageMatch = /^\/v1\/generations\/([0-9a-f-]{36})\/usage$/.exec(url.pathname);
  if (usageMatch && request.method === 'GET') {
    const result = await call(env, account.id, '/usage', {generationId: usageMatch[1]});
    return reply(result.value, result.status);
  }
  const match = /^\/v1\/generations\/([0-9a-f-]{36})$/.exec(url.pathname); if (match && request.method === 'GET') { const found = await call(env, account.id, '/job', {generationId: match[1]}); return found.status === 200 ? saved(env, found.value.job, found.value.access) : fail('not_found', 'Generation not found.', 404); }
  return fail('not_found', 'Not found.', 404);
}

function moderationModelForLog(env) {
  try { return moderationModel(env); } catch { return 'invalid'; }
}
