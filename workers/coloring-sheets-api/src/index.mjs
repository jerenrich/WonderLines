// Public v1 API. An account is a random UUID; no sign-in or personal profile exists.
import {DEFAULT_MODEL, modelCatalog, imageRequest, runImageRequest, ImageProviderError} from './image-provider.mjs';
import {imageCost} from './image-cost.mjs';
const DEFAULT = {width: 1024, height: 1456}, TOKEN_SECONDS = 2592000, encoder = new TextEncoder();
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
  const value = Number(env.FREE_DAILY_ALLOWANCE ?? 3);
  return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}
function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64(s) { return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
async function key(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']); }
async function token(sub, cid, secret) { const body = b64(encoder.encode(JSON.stringify({v: 1, sub, cid, exp: Math.floor(Date.now() / 1000) + TOKEN_SECONDS}))); return body + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body)))); }
async function claims(header, secret, allowExpired = false) {
  if (!header?.startsWith('Bearer ') || !secret) return null;
  const [body, signature, extra] = header.slice(7).split('.'); if (!body || !signature || extra) return null;
  try { const value = JSON.parse(new TextDecoder().decode(unb64(body))); return await crypto.subtle.verify('HMAC', await key(secret), unb64(signature), encoder.encode(body)) && value.v === 1 && /^[0-9a-f-]{36}$/.test(value.sub) && /^[0-9a-f-]{36}$/.test(value.cid) && Number.isSafeInteger(value.exp) && (allowExpired || value.exp > Date.now() / 1000) ? value : null; } catch { return null; }
}
async function body(request) { if (!request.headers.get('Content-Type')?.startsWith('application/json')) return null; const text = await request.text(); if (text.length > 4096) return null; try { return JSON.parse(text); } catch { return null; } }
async function digest(value) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
function stub(env, id) { return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id)); }
async function call(env, id, path, input) { const response = await stub(env, id).fetch('https://account' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)}); return {status: response.status, value: await response.json()}; }
async function reserveGlobalBudget(env, claim) {
  const object = env.BUDGET.get(env.BUDGET.idFromName('daily-generation-budget'));
  const response = await object.fetch('https://budget/reserve', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({claim})});
  return {status: response.status, value: await response.json()};
}
const accessHeader = access => encodeURIComponent(JSON.stringify(access));

// This second DO caps total daily spend even if an attacker repeatedly registers
// fresh anonymous installations.
export class Budget {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const input = await request.json().catch(() => null);
    if (new URL(request.url).pathname !== '/reserve' || typeof input?.claim !== 'string') return fail('invalid_request', 'Invalid budget reservation.', 400);
    if (await this.state.storage.get('claim:' + input.claim)) return reply({reserved: true});
    const day = new Date().toISOString().slice(0, 10), existing = await this.state.storage.get('usage');
    const used = existing?.day === day ? existing.used : 0, limit = globalDailyGenerationLimit(this.env.GLOBAL_DAILY_GENERATION_LIMIT);
    if (limit === null) return fail('service_unavailable', 'The service budget is not configured.', 503);
    if (used >= limit) return fail('global_budget_exhausted', 'The service is unavailable today.', 429);
    await this.state.storage.put('usage', {day, used: used + 1});
    await this.state.storage.put('claim:' + input.claim, true);
    return reply({reserved: true}, 201);
  }
}

// One DO per anonymous account makes allowance reservation and credit deduction atomic.
export class Account {
  constructor(state, env) { this.state = state; this.env = env; this.reservations = Promise.resolve(); }
  async fetch(request) {
    const input = await request.json().catch(() => null), path = new URL(request.url).pathname;
    if (!input || request.method !== 'POST') return fail('invalid_request', 'Send JSON.', 400);
    if (path === '/initialize') return this.initialize(input);
    const account = await this.state.storage.get('account');
    if (!account) return fail('unknown_account', 'Unknown account.', 404);
    if (path === '/authorize') return account.credentialId === input.credentialId ? reply({access: await this.access()}) : fail('invalid_token', 'Invalid token.', 401);
    if (path === '/reserve') {
      // The global budget call yields to other requests. Keep account reservations
      // in order so a parallel batch cannot read and spend the same allowance.
      const reservation = this.reservations.then(() => this.reserve(input));
      this.reservations = reservation.catch(() => {});
      return reservation;
    }
    if (path === '/job') return this.job(input);
    if (path === '/complete') return this.complete(input);
    if (path === '/access') return reply({access: await this.access()});
    return fail('not_found', 'Not found.', 404);
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
  async reserve({generationId, fingerprint}) {
    if (!/^[0-9a-f-]{36}$/.test(generationId) || typeof fingerprint !== 'string') return fail('invalid_request', 'Invalid generation.', 400);
    const jobKey = 'job:' + generationId, existing = await this.state.storage.get(jobKey);
    if (existing) return existing.fingerprint === fingerprint ? reply({job: existing, access: await this.access()}) : fail('idempotency_conflict', 'Generation ID was already used.', 409);
    const day = new Date().toISOString().slice(0, 10), allowance = freeDailyAllowance(this.env), usage = await this.state.storage.get('usage');
    const used = usage?.day === day ? usage.used : 0; let credits = (await this.state.storage.get('credits')) ?? 0;
    if (used >= allowance && credits < 1) return fail('allowance_exhausted', 'Today’s free sheet allowance has been used.', 429);
    const global = await reserveGlobalBudget(this.env, (await this.state.storage.get('account')).id + ':' + generationId);
    if (global.status === 429) return fail('service_budget_exhausted', 'The service is unavailable today.', 429);
    if (global.status >= 400) return fail('service_unavailable', 'Could not reserve service capacity.', 503);
    if (used < allowance) await this.state.storage.put('usage', {day, used: used + 1}); else await this.state.storage.put('credits', --credits);
    const job = {id: generationId, fingerprint, state: 'processing', createdAt: Date.now()}; await this.state.storage.put(jobKey, job);
    return reply({job, access: await this.access()}, 201);
  }
  async job({generationId}) { const job = await this.state.storage.get('job:' + generationId); return job ? reply({job, access: await this.access()}) : fail('not_found', 'Generation not found.', 404); }
  async complete({generationId, result}) { const k = 'job:' + generationId, job = await this.state.storage.get(k); if (!job || job.state !== 'processing') return fail('not_found', 'Generation not found.', 404); Object.assign(job, result, {completedAt: Date.now()}); await this.state.storage.put(k, job); return reply({access: await this.access()}); }
}

async function authenticate(request, env, allowExpired = false) { const c = await claims(request.headers.get('Authorization'), env.ACCOUNT_TOKEN_SECRET, allowExpired); if (!c) return null; const checked = await call(env, c.sub, '/authorize', {credentialId: c.cid}); return checked.status === 200 ? {id: c.sub, credentialId: c.cid, access: checked.value.access} : null; }
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
  const reservation = await call(env, account.id, '/reserve', {generationId, fingerprint});
  if (reservation.status === 429) return reply(reservation.value, 429);
  if (reservation.status >= 400) return fail('generation_unavailable', 'Could not start generation.', reservation.status);
  if (reservation.status === 200 || reservation.value.job.state !== 'processing') return saved(env, reservation.value.job, reservation.value.access);
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
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    try {
      const {defaultModel, routes} = modelCatalog(env);
      return reply({defaultModel, models: Object.entries(routes).map(([id, route]) => ({id, ...route}))});
    } catch { return fail('service_unavailable', 'Image model configuration is incomplete.', 503); }
  }
  if (url.pathname === '/v1/access' && request.method === 'GET') return reply({access: account.access});
  if (url.pathname === '/v1/generations' && request.method === 'POST') return generate(request, env, account);
  const match = /^\/v1\/generations\/([0-9a-f-]{36})$/.exec(url.pathname); if (match && request.method === 'GET') { const found = await call(env, account.id, '/job', {generationId: match[1]}); return found.status === 200 ? saved(env, found.value.job, found.value.access) : fail('not_found', 'Generation not found.', 404); }
  return fail('not_found', 'Not found.', 404);
}};
