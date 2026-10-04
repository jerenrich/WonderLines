// Public v1 API. An account is a random UUID; no sign-in or personal profile exists.
import {DEFAULT_MODEL, modelCatalog, imageRequest, runImageRequest, ImageProviderError, submitFalRequest, pollFalRequest, falBillableUnits} from './image-provider.mjs';
import {imageCost} from './image-cost.mjs';
import {falCostData} from './fal-cost.mjs';
import {verifyAttestation, verifyAssertion, acceptCounter, fromB64url, b64url} from './app-attest.mjs';
const DEFAULT = {width: 1024, height: 1456}, TOKEN_SECONDS = 2592000, encoder = new TextEncoder();
const DAILY_IMAGE_LIMIT = 100;
const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}});
const fail = (code, message, status) => reply({error: {code, message}}, status);
function dimensions(input) {
  const {width, height} = input ?? {};
  if (width === undefined && height === undefined) return DEFAULT;
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= 3840 && height <= 3840 &&
    width % 16 === 0 && height % 16 === 0 && width / height >= 1 / 3 && width / height <= 3 && width * height >= 655360 && width * height <= 3686400 ? {width, height} : null;
}
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
async function body(request, max = 4096) { if (!request.headers.get('Content-Type')?.startsWith('application/json')) return null; const text = await request.text(); if (text.length > max) return null; try { return JSON.parse(text); } catch { return null; } }
async function digest(value) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
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
      if (falUsed >= falLimit) return fail('service_budget_exhausted', 'The fal daily trial limit has been reached. Choose another model.', 429);
      await this.state.storage.put('fal-usage', {day, used: falUsed + 1});
    }
    await this.state.storage.put('usage', {day, used: used + 1});
    await this.state.storage.put('claim:' + input.claim, true);
    return reply({reserved: true}, 201);
  }
}

// One DO per anonymous account makes allowance reservation and credit deduction atomic.
export class Account {
  constructor(state, env) { this.state = state; this.env = env; this.reservations = Promise.resolve(); this.attestUpdates = Promise.resolve(); }
  async fetch(request) {
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
    if (path === '/reserve') {
      // The global budget call yields to other requests. Keep account reservations
      // in order so a parallel batch cannot read and spend the same allowance.
      const reservation = this.reservations.then(() => this.reserve(input));
      this.reservations = reservation.catch(() => {});
      return reservation;
    }
    if (path === '/job') return this.job(input);
    if (path === '/usage') return this.usage(input);
    if (path === '/complete') return this.complete(input);
    if (path === '/access') return reply({access: await this.access()});
    return fail('not_found', 'Not found.', 404);
  }
  async registerAttestation(input) {
    if (typeof input.keyID !== 'string' || typeof input.publicKey !== 'string' || input.publicKey.length > 1024) return fail('invalid_request', 'Invalid attestation.', 400);
    const previous = await this.state.storage.get('app-attest');
    if (previous && previous.keyID !== input.keyID) return fail('attestation_conflict', 'This installation already has an attested key.', 409);
    const account = await this.state.storage.get('account');
    if (!previous || !account.appAttested) {
      await this.state.storage.transaction(async storage => {
        if (!previous) await storage.put('app-attest', {keyID: input.keyID, publicKey: input.publicKey, counter: 0, seen: '0'});
        if (!account.appAttested) await storage.put('account', {...account, appAttested: true});
      });
    }
    return reply({attested: true});
  }
  async assertion({assertion, clientData}) {
    const record = await this.state.storage.get('app-attest');
    if (!record) return fail('app_attest_required', 'This installation needs App Attest enrollment.', 403);
    try {
      const counter = verifyAssertion(assertion, fromB64url(clientData, 2048), record.publicKey, this.env.APP_ATTEST_APP_ID);
      await this.state.storage.put('app-attest', acceptCounter(record, counter));
      return reply({verified: true});
    } catch (error) {
      // Only known verifier labels: never log the assertion, client data, key,
      // arbitrary exception messages, or request headers.
      const labels = ['Invalid encoding', 'Invalid CBOR', 'Invalid assertion', 'Invalid assertion extensions',
        'Invalid RP ID', 'Invalid App ID', 'Invalid assertion counter', 'Invalid assertion signature', 'Replayed assertion'];
      console.warn(JSON.stringify({event: 'app_attest_rejected',
        reason: labels.includes(error?.message) ? error.message : 'Verification unavailable'}));
      return fail('invalid_assertion', 'App Attest assertion could not be verified.', 403);
    }
  }
  async initialize({accountId}) {
    if (!/^[0-9a-f-]{36}$/.test(accountId) || await this.state.storage.get('account')) return fail('invalid_account', 'Invalid account.', 409);
    const account = {id: accountId, credentialId: crypto.randomUUID()}; await this.state.storage.put('account', account);
    return reply({credentialId: account.credentialId, access: await this.access()}, 201);
  }
  async access() {
    const day = new Date().toISOString().slice(0, 10), allowance = freeDailyAllowance(this.env);
    const usage = await this.state.storage.get('usage'), credits = (await this.state.storage.get('credits')) ?? 0;
    return {features: [], generationCredits: credits, freeGenerationsRemaining: Math.max(0, allowance - (usage?.day === day ? usage.used : 0)), allowanceResetsAt: new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString()};
  }
  async reserve({generationId, fingerprint, falTask}) {
    if (!/^[0-9a-f-]{36}$/.test(generationId) || typeof fingerprint !== 'string') return fail('invalid_request', 'Invalid generation.', 400);
    const jobKey = 'job:' + generationId, existing = await this.state.storage.get(jobKey);
    if (existing) return existing.fingerprint === fingerprint ? reply({job: existing, access: await this.access()}) : fail('idempotency_conflict', 'Generation ID was already used.', 409);
    const day = new Date().toISOString().slice(0, 10), allowance = freeDailyAllowance(this.env), usage = await this.state.storage.get('usage');
    const used = usage?.day === day ? usage.used : 0; let credits = (await this.state.storage.get('credits')) ?? 0;
    if (used >= DAILY_IMAGE_LIMIT) return fail('allowance_exhausted', 'Today’s limit of 100 images has been reached. It resets at midnight UTC.', 429);
    if (used >= allowance && credits < 1) return fail('allowance_exhausted', 'Today’s free sheet allowance has been used.', 429);
    const global = await reserveGlobalBudget(this.env, (await this.state.storage.get('account')).id + ':' + generationId, falTask ? 'fal' : undefined);
    if (global.status === 429) return fail('service_budget_exhausted', global.value.error.message, 429);
    if (global.status >= 400) return fail('service_unavailable', 'Could not reserve service capacity.', 503);
    await this.state.storage.put('usage', {day, used: used + 1});
    if (used >= allowance) await this.state.storage.put('credits', --credits);
    const job = {id: generationId, fingerprint, state: 'processing', createdAt: Date.now(),
      ...(falTask ? {fal: {...falTask, stage: 'queued'}} : {})};
    if (falTask) {
      // Job and alarm commit together; a disconnected POST cannot strand a queue submission.
      await this.state.storage.transaction(async storage => {
        await storage.put(jobKey, job);
        await storage.put('fal:' + generationId, generationId);
        await storage.setAlarm(Date.now() + 1000);
      });
    } else await this.state.storage.put(jobKey, job);
    return reply({job, access: await this.access()}, 201);
  }
  async alarm() {
    const pending = await this.state.storage.list({prefix: 'fal:', limit: 5});
    if (!pending.size) return;
    // Schedule a watchdog before network IO. Alarm retries only poll recorded IDs;
    // they must never repeat an ambiguous submission after a crash.
    await this.state.storage.setAlarm(Date.now() + 30000);
    await Promise.all([...pending.values()].map(id => this.advanceFal(id)));
    if ((await this.state.storage.list({prefix: 'fal:', limit: 1})).size) {
      await this.state.storage.setAlarm(Date.now() + 5000);
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
      await finishFailure('provider_timeout', 'The fal job could not be recovered within 30 minutes. Generation may have been charged; check provider usage before generating again.');
      return;
    }
    if (job.fal.stage === 'submitting') {
      await finishFailure('provider_connection_failed', 'The fal submission was interrupted before its job ID could be saved. Generation may have been charged; check provider usage before generating again.');
      return;
    }
    if (job.fal.stage === 'queued') {
      job.fal.stage = 'submitting';
      await this.state.storage.put('job:' + id, job);
      let requestID;
      try { requestID = await submitFalRequest(this.env, job.fal.request); }
      catch (error) {
        await finishFailure(error instanceof ImageProviderError ? error.code : 'provider_connection_failed',
          error instanceof ImageProviderError ? error.message : 'The fal submission could not be confirmed. Generation may have been charged.');
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
      const result = await pollFalRequest(this.env, job.fal.requestID);
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
  async job({generationId}) { const job = await this.state.storage.get('job:' + generationId); return job ? reply({job, access: await this.access()}) : fail('not_found', 'Generation not found.', 404); }
  async recordFalUsage(job) {
    const request = job.fal.request;
    const costData = await falCostData(this.env, job.fal.requestID, job.metrics?.billableUnits, job.createdAt);
    job.metrics = {...job.metrics, provider: 'fal', upstreamModel: request.model,
      requestedModel: job.fal.publicModel, requestedSize: job.fal.requestedSize,
      modelRevision: request.modelRevision, ...costData, ...imageCost(request, {...job.metrics, ...costData}),
      imageCount: request.payload?.num_images ?? job.metrics?.imageCount ?? 1,
      inferenceSteps: request.payload?.num_inference_steps ?? job.metrics?.inferenceSteps ?? 30};
    const audit = {event: 'fal_usage', generationID: job.id, state: job.state, errorCode: job.errorCode ?? null,
      createdAt: job.createdAt, completedAt: job.completedAt, ...job.metrics};
    const account = await this.state.storage.get('account');
    // Stable key: repeat status reads update one ledger entry, never another charge.
    try { await this.env.GENERATIONS.put(account.id + '/' + job.id + '.usage.json', JSON.stringify(audit),
      {httpMetadata: {contentType: 'application/json'}}); }
    catch { console.warn(JSON.stringify({event: 'fal_usage_storage_failed', generationID: job.id})); }
    console.info(JSON.stringify(audit));
  }
  async usage({generationId}) {
    const job = await this.state.storage.get('job:' + generationId);
    if (!job) return fail('not_found', 'Generation not found.', 404);
    if (job.fal && job.state !== 'processing' && job.metrics?.costStatus !== 'reported' &&
        (!job.metrics?.costCheckedAt || Date.now() - Date.parse(job.metrics.costCheckedAt) > 60000)) {
      if (job.state === 'completed' && job.metrics?.billableUnits == null) {
        job.metrics = {...job.metrics, billableUnits: await falBillableUnits(this.env, job.fal.requestID)};
      }
      await this.recordFalUsage(job);
      await this.state.storage.put('job:' + generationId, job);
    }
    return reply({generationId, status: job.state, metrics: job.metrics ?? null});
  }
  async complete({generationId, result}) {
    const k = 'job:' + generationId, job = await this.state.storage.get(k);
    if (!job || job.state !== 'processing') return fail('not_found', 'Generation not found.', 404);
    Object.assign(job, result, {completedAt: Date.now()});
    if (job.fal?.request) {
      await this.recordFalUsage(job);
      delete job.fal.request.payload;
    }
    await this.state.storage.put(k, job);
    return reply({access: await this.access()});
  }
}

async function authenticate(request, env, allowExpired = false) { const c = await claims(request.headers.get('Authorization'), env.ACCOUNT_TOKEN_SECRET, allowExpired); if (!c) return null; const checked = await call(env, c.sub, '/authorize', {credentialId: c.cid}); return checked.status === 200 ? {id: c.sub, credentialId: c.cid, access: checked.value.access, appAttested: checked.value.appAttested} : null; }
async function saved(env, job, access) {
  if (job.state === 'completed') { const image = await env.GENERATIONS.get(job.objectKey); if (!image) return fail('result_unavailable', 'Saved image is unavailable.', 410); return new Response(image.body, {headers: {'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Generation-ID': job.id, 'X-Generation-Metrics': encodeURIComponent(JSON.stringify(job.metrics)), 'X-Access-Snapshot': accessHeader(access)}}); }
  if (job.state === 'failed') return fail(job.errorCode ?? 'upstream_failed', job.message, 502);
  return reply({generationId: job.id, status: 'processing'}, 202, {'Retry-After': '5', 'X-Access-Snapshot': accessHeader(access)});
}
async function generate(request, env, account) {
  const input = await body(request), generationId = request.headers.get('Idempotency-Key');
  if (!input || !/^[0-9a-f-]{36}$/.test(generationId ?? '')) return fail('invalid_request', 'Send JSON and a UUID Idempotency-Key.', 400);
  const size = dimensions(input);
  if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 500 || !size) return fail('invalid_request', 'Description or dimensions are invalid.', 400);
  // A retry identifies the original public request, not today's provider route.
  // Recover it before validating configuration so rotations cannot strand jobs.
  const model = input.model ?? env.IMAGE_DEFAULT_MODEL ?? DEFAULT_MODEL;
  const fingerprint = await digest(JSON.stringify({subject: input.subject, model, ...size}));
  const existing = await call(env, account.id, '/job', {generationId});
  if (existing.status === 200) return existing.value.job.fingerprint === fingerprint
    ? saved(env, existing.value.job, existing.value.access)
    : fail('idempotency_conflict', 'Generation ID was already used.', 409);
  if (existing.status !== 404) return fail('service_unavailable', 'Could not check generation.', 503);
  let catalog, upstreamRequest;
  try { catalog = modelCatalog(env); }
  catch { return fail('service_unavailable', 'Image model configuration is incomplete.', 503); }
  if (typeof model !== 'string' || !Object.hasOwn(catalog.routes, model)) return fail('invalid_request', 'Model is invalid.', 400);
  try { upstreamRequest = imageRequest(env, catalog.routes[model], input.subject, size); }
  catch { return fail('service_unavailable', 'Image provider configuration is incomplete.', 503); }
  const reservation = await call(env, account.id, '/reserve', {generationId, fingerprint,
    ...(upstreamRequest.provider === 'fal' ? {falTask: {request: upstreamRequest, publicModel: model,
      requestedSize: size.width + 'x' + size.height}} : {})});
  if (reservation.status === 429) return reply(reservation.value, 429);
  if (reservation.status >= 400) return fail('generation_unavailable', 'Could not start generation.', reservation.status);
  if (reservation.status === 200 || reservation.value.job.state !== 'processing') return saved(env, reservation.value.job, reservation.value.access);
  if (upstreamRequest.provider === 'fal') return saved(env, reservation.value.job, reservation.value.access);
  try {
    const started = Date.now(), result = await runImageRequest(upstreamRequest);
    const {image, size: actualSize, inputTokens, textInputTokens, imageInputTokens, outputTokens, totalTokens} = result;
    const objectKey = account.id + '/' + generationId + '.png';
    const metrics = {requestedModel: model, provider: upstreamRequest.provider, upstreamModel: upstreamRequest.model,
      viaGateway: upstreamRequest.viaGateway, requestedSize: size.width + 'x' + size.height, size: actualSize,
      inputTokens, textInputTokens: textInputTokens ?? null, imageInputTokens: imageInputTokens ?? null,
      outputTokens, totalTokens, elapsedMs: Date.now() - started, ...imageCost(upstreamRequest, result)};
    await env.GENERATIONS.put(objectKey, image, {httpMetadata: {contentType: 'image/png'}});
    const completed = await call(env, account.id, '/complete', {generationId, result: {state: 'completed', objectKey, metrics}});
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

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (!env.ACCOUNT_TOKEN_SECRET) return fail('service_unavailable', 'Service configuration is incomplete.', 503);
  if (url.pathname === '/v1/installations') { if (request.method !== 'POST' || !await body(request)) return fail('invalid_request', 'Send an empty JSON object.', 400); const id = crypto.randomUUID(), made = await call(env, id, '/initialize', {accountId: id}); if (made.status !== 201) return fail('service_unavailable', 'Could not create an anonymous account.', 503); return reply({accountId: id, accessToken: await token(id, made.value.credentialId, env.ACCOUNT_TOKEN_SECRET), expiresAt: Math.floor(Date.now() / 1000) + TOKEN_SECONDS, access: made.value.access}, 201); }
  if (url.pathname === '/v1/installations/renew') {
    if (request.method !== 'POST' || !await body(request)) return fail('invalid_request', 'Send an empty JSON object.', 400);
    // Only renewal accepts an expired signed credential. The account must still
    // exist and its credentialId must match, so revocation also blocks renewal.
    const account = await authenticate(request, env, true);
    if (!account) return fail('unauthorized', 'The saved account credential could not be renewed.', 401);
    return reply({accountId: account.id, accessToken: await token(account.id, account.credentialId, env.ACCOUNT_TOKEN_SECRET), expiresAt: Math.floor(Date.now() / 1000) + TOKEN_SECONDS, access: account.access});
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
    if (signed || account.appAttested || env.APP_ATTEST_ENFORCE === 'true') {
      if (!appAttestConfigured(env)) return fail('service_unavailable', 'App Attest is not configured.', 503);
      const encoded = request.headers.get('X-App-Attest-Client-Data');
      let clientData;
      try {
        clientData = fromB64url(encoded, 2048);
        const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(clientData));
        const raw = await request.clone().arrayBuffer();
        if (raw.byteLength > 4096 || parsed.method !== 'POST' || parsed.path !== '/v1/generations' ||
            parsed.idempotencyKey !== request.headers.get('Idempotency-Key') ||
            parsed.bodySHA256 !== b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))) ||
            !await challengeValid(parsed.challenge, account.id, 'assertion', env.ACCOUNT_TOKEN_SECRET)) {
          return fail('invalid_assertion', 'Invalid App Attest request binding.', 403);
        }
      } catch { return fail('invalid_assertion', 'Invalid App Attest request binding.', 403); }
      const checked = await call(env, account.id, '/assertion', {assertion: signed, clientData: encoded});
      if (checked.status !== 200) return reply(checked.value, checked.status);
    }
    return generate(request, env, account);
  }
  const usageMatch = /^\/v1\/generations\/([0-9a-f-]{36})\/usage$/.exec(url.pathname);
  if (usageMatch && request.method === 'GET') {
    const result = await call(env, account.id, '/usage', {generationId: usageMatch[1]});
    return reply(result.value, result.status);
  }
  const match = /^\/v1\/generations\/([0-9a-f-]{36})$/.exec(url.pathname); if (match && request.method === 'GET') { const found = await call(env, account.id, '/job', {generationId: match[1]}); return found.status === 200 ? saved(env, found.value.job, found.value.access) : fail('not_found', 'Generation not found.', 404); }
  return fail('not_found', 'Not found.', 404);
}};
