// Exercises the public Worker API with in-memory Durable Object/R2 bindings only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker, {Account, Budget} from '../workers/coloring-sheets-api/src/index.mjs';
import {modelCatalog} from '../workers/coloring-sheets-api/src/image-provider.mjs';

// A picker option must have a server route, and every built-in route is selectable.
const swiftModels = readFileSync(new URL('../ColoringSheets/Core/Generation.swift', import.meta.url), 'utf8')
  .split('// App-owned page policy:')[0];
const pickerIDs = [...swiftModels.matchAll(/case \w+ = "([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(pickerIDs.sort(), Object.keys(modelCatalog({}).routes).sort());

class MemoryStorage { constructor() { this.values = new Map(); } async get(k) { return this.values.get(k); } async put(k, v) { this.values.set(k, v); } }
class Accounts {
  constructor(env) { this.env = env; this.objects = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new Account({storage: new MemoryStorage()}, this.env));
    return {fetch: (request, init) => this.objects.get(id).fetch(new Request(request, init))};
  }
}
class Images {
  constructor() { this.values = new Map(); }
  async put(key, value) { this.values.set(key, value); }
  async get(key) { const value = this.values.get(key); return value && {body: new Response(value).body}; }
}
class BudgetNamespace {
  constructor(env) { this.env = env; this.objects = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.objects.has(id)) this.objects.set(id, new Budget({storage: new MemoryStorage()}, this.env));
    return {fetch: (request, init) => this.objects.get(id).fetch(new Request(request, init))};
  }
}
const env = {OPENAI_API_KEY: 'synthetic', ACCOUNT_TOKEN_SECRET: 'synthetic-token-secret', FREE_DAILY_ALLOWANCE: '3', GLOBAL_DAILY_GENERATION_LIMIT: '10000'};
env.ACCOUNTS = new Accounts(env); env.BUDGET = new BudgetNamespace(env); env.GENERATIONS = new Images();
const originalFetch = globalThis.fetch;
let calls = 0, forwarded;
globalThis.fetch = async (url, request) => {
  assert.equal(url, 'https://api.openai.com/v1/images/generations'); calls++;
  forwarded = JSON.parse(request.body);
  return new Response(JSON.stringify({data: [{b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='}], usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3}}));
};
try {
  const registered = await worker.fetch(new Request('https://example.test/v1/installations', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}), env);
  assert.equal(registered.status, 201); const identity = await registered.json();
  assert.match(identity.accountId, /^[0-9a-f-]{36}$/); assert.ok(identity.accessToken);
  const generationId = crypto.randomUUID();
  const request = () => new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': generationId}, body: JSON.stringify({subject: 'Synthetic flower. Complexity: very simple outlines', model: 'gpt-image-2.5-flare', width: 1456, height: 1024})});
  let response = await worker.fetch(request(), env); assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(forwarded.model, 'gpt-image-2.5-flare');
  assert.equal(forwarded.size, '1456x1024'); assert.ok(forwarded.prompt.includes('Synthetic flower'));
  response = await worker.fetch(request(), env); assert.equal(response.status, 200); assert.equal(calls, 1, 'A repeated ID must return the stored image.');
  const sunburst = new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'Synthetic flower', model: 'gpt-image-2.5-sunburst', width: 1456, height: 1024})});
  response = await worker.fetch(sunburst, env); assert.equal(response.status, 200); assert.equal(calls, 2);
  assert.equal(forwarded.model, 'gpt-image-2.5-sunburst', 'The selected model must reach OpenAI.');
  const access = await worker.fetch(new Request('https://example.test/v1/access', {headers: {'Authorization': 'Bearer ' + identity.accessToken}}), env);
  assert.equal((await access.json()).access.freeGenerationsRemaining, 1);
  const invalid = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'x', width: 17, height: 17})}), env);
  assert.equal(invalid.status, 400); assert.equal(calls, 2, 'Validation must run before a reservation or paid call.');
  const invalidModel = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}, body: JSON.stringify({subject: 'Synthetic flower', model: 'unsupported-model'})}), env);
  assert.equal(invalidModel.status, 400); assert.equal(calls, 2, 'Unsupported models must be rejected before a paid call.');
  const zeroCap = new Budget({storage: new MemoryStorage()}, {GLOBAL_DAILY_GENERATION_LIMIT: '0'});
  response = await zeroCap.fetch(new Request('https://budget/reserve', {method: 'POST', body: JSON.stringify({claim: 'test-zero'})}));
  assert.equal(response.status, 429, 'A configured zero cap must stop global reservations.');
  const malformedCap = new Budget({storage: new MemoryStorage()}, {GLOBAL_DAILY_GENERATION_LIMIT: 'not-a-number'});
  response = await malformedCap.fetch(new Request('https://budget/reserve', {method: 'POST', body: JSON.stringify({claim: 'test-malformed'})}));
  assert.equal(response.status, 503, 'A malformed cap must fail closed.');
  // At the new allowance boundary, a concurrent batch may reserve only the two
  // remaining images. The remote budget call must not permit lost usage updates.
  const largeEnv = {...env, FREE_DAILY_ALLOWANCE: '1000'};
  largeEnv.ACCOUNTS = new Accounts(largeEnv); largeEnv.BUDGET = new BudgetNamespace(largeEnv);
  const accountID = crypto.randomUUID(), largeStub = largeEnv.ACCOUNTS.get(accountID);
  response = await largeStub.fetch('https://account/initialize', {method: 'POST', body: JSON.stringify({accountId: accountID})});
  assert.equal((await response.json()).access.freeGenerationsRemaining, 1000);
  const account = largeEnv.ACCOUNTS.objects.get(accountID);
  await account.state.storage.put('usage', {day: new Date().toISOString().slice(0, 10), used: 998});
  const reserve = generationId => largeStub.fetch('https://account/reserve', {method: 'POST', body: JSON.stringify({generationId, fingerprint: 'synthetic'})});
  const ids = Array.from({length: 5}, () => crypto.randomUUID());
  const reservations = await Promise.all(ids.map(reserve));
  assert.deepEqual(reservations.map(r => r.status), [201, 201, 429, 429, 429]);
  assert.equal((await account.access()).freeGenerationsRemaining, 0);
  assert.equal((await reserve(ids[0])).status, 200, 'A repeated ID must not consume another allowance.');
  assert.equal((await account.state.storage.get('usage')).used, 1000);
  // An in-flight duplicate recovers the existing job, without calling OpenAI twice.
  let releaseUpstream;
  const upstreamWaiting = new Promise(resolve => { releaseUpstream = resolve; });
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let concurrentCalls = 0;
  globalThis.fetch = async () => {
    concurrentCalls++; notifyStarted(); await upstreamWaiting;
    return new Response(JSON.stringify({data: [{b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='}]}));
  };
  const duplicateID = crypto.randomUUID();
  const duplicateRequest = () => new Request('https://example.test/v1/generations', {method: 'POST', headers: {
    'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': duplicateID
  }, body: JSON.stringify({subject: 'Synthetic flower'})});
  const first = worker.fetch(duplicateRequest(), env);
  await started;
  response = await worker.fetch(duplicateRequest(), env);
  assert.equal(response.status, 202);
  assert.equal(concurrentCalls, 1);
  releaseUpstream();
  assert.equal((await first).status, 200);
  // Expiry must not create a new account or strand its credits and saved jobs.
  const storedAccount = env.ACCOUNTS.objects.get(identity.accountId);
  await storedAccount.state.storage.put('credits', 7);
  const beforeRenewal = await storedAccount.access();
  const accountCount = env.ACCOUNTS.objects.size;
  const originalNow = Date.now;
  const renewRequest = credential => new Request('https://example.test/v1/installations/renew', {
    method: 'POST', headers: {'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'}, body: '{}'
  });
  try {
    Date.now = () => originalNow() + 31 * 24 * 60 * 60 * 1000;
    response = await worker.fetch(request(), env);
    assert.equal(response.status, 401, 'Expired credentials cannot generate images.');
    response = await worker.fetch(renewRequest(identity.accessToken), env);
    assert.equal(response.status, 200);
    const renewed = await response.json();
    assert.equal(renewed.accountId, identity.accountId);
    assert.ok(renewed.expiresAt > Date.now() / 1000);
    assert.deepEqual(renewed.access, beforeRenewal);
    assert.equal(env.ACCOUNTS.objects.size, accountCount, 'Renewal cannot initialize another account.');
    response = await worker.fetch(new Request('https://example.test/v1/generations/' + generationId, {
      headers: {'Authorization': 'Bearer ' + renewed.accessToken}
    }), env);
    assert.equal(response.status, 200, 'Renewed identity can recover its old images.');
    assert.equal(concurrentCalls, 1, 'Renewal and recovery do not call the image provider.');
    assert.equal((await worker.fetch(renewRequest(identity.accessToken + 'x'), env)).status, 401);
    const savedAccount = await storedAccount.state.storage.get('account');
    await storedAccount.state.storage.put('account', {...savedAccount, credentialId: crypto.randomUUID()});
    assert.equal((await worker.fetch(renewRequest(identity.accessToken), env)).status, 401,
                 'Expired credentials still require the current, unrevoked credential ID.');
    await storedAccount.state.storage.put('account', savedAccount);
  } finally { Date.now = originalNow; }
  // AI Gateway integration: all requests are intercepted, including failures.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
  const gatewayEnv = {...env, FREE_DAILY_ALLOWANCE: '1000', AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32),
    AI_GATEWAY_ID: 'coloring-sheets', AI_GATEWAY_TOKEN: 'synthetic-gateway-token'};
  gatewayEnv.ACCOUNTS = new Accounts(gatewayEnv); gatewayEnv.BUDGET = new BudgetNamespace(gatewayEnv);
  gatewayEnv.GENERATIONS = new Images();
  const gatewayIdentity = await (await worker.fetch(new Request('https://example.test/v1/installations', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
  }), gatewayEnv)).json();
  const auth = {'Authorization': 'Bearer ' + gatewayIdentity.accessToken};
  const generateRequest = (model, id = crypto.randomUUID(), extras = {}) => new Request('https://example.test/v1/generations', {
    method: 'POST', headers: {...auth, 'Content-Type': 'application/json', 'Idempotency-Key': id},
    body: JSON.stringify({subject: 'Synthetic flower', model, width: 1456, height: 1024, ...extras})
  });
  const get = path => worker.fetch(new Request('https://example.test' + path, {headers: auth}), gatewayEnv);
  let gatewayCalls = 0, gatewayURL, gatewayHeaders, gatewayPayload;
  globalThis.fetch = async (url, init) => {
    gatewayCalls++; gatewayURL = url; gatewayHeaders = new Headers(init.headers); gatewayPayload = JSON.parse(init.body);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({data: [{b64_json: png}], usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3}});
  };
  const gatewayID = crypto.randomUUID();
  response = await worker.fetch(generateRequest('gpt-image-2.5-flare', gatewayID), gatewayEnv);
  assert.equal(response.status, 200);
  assert.equal(gatewayURL, 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/coloring-sheets/openai/images/generations');
  assert.equal(gatewayHeaders.get('Authorization'), 'Bearer synthetic', 'Keep billing the existing OpenAI key.');
  assert.equal(gatewayHeaders.get('cf-aig-authorization'), 'Bearer synthetic-gateway-token');
  assert.equal(gatewayHeaders.get('cf-aig-skip-cache'), 'true');
  assert.equal(gatewayHeaders.get('cf-aig-max-attempts'), '1');
  assert.equal(gatewayPayload.size, '1456x1024');
  assert.equal(gatewayPayload.quality, 'low');
  assert.equal(gatewayPayload.output_format, 'png');
  assert.equal(gatewayPayload.n, 1);
  assert.match(gatewayPayload.prompt, /child-appropriate/);
  let metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
  assert.equal(metrics.provider, 'openai'); assert.equal(metrics.viaGateway, true);
  assert.equal(metrics.upstreamModel, 'gpt-image-2.5-flare'); assert.equal(metrics.totalTokens, 3);
  assert.equal(metrics.size, '1x1', 'Report dimensions from the actual PNG.');
  const savedBytes = new Uint8Array(await response.arrayBuffer());
  gatewayEnv.AI_GATEWAY_KEY_SOURCE = 'gateway';
  response = await worker.fetch(generateRequest(), gatewayEnv);
  assert.equal(response.status, 200);
  assert.equal(gatewayHeaders.has('Authorization'), false, 'Stored BYOK must omit even a retained Worker key.');
  delete gatewayEnv.OPENAI_API_KEY;
  assert.equal((await worker.fetch(generateRequest(), gatewayEnv)).status, 200, 'Stored BYOK works without an OpenAI Worker secret.');
  // A public ID can be remapped to another model without changing the app.
  gatewayEnv.IMAGE_MODEL_ROUTES = JSON.stringify({
    'gpt-image-2.5-flare': {provider: 'openai', model: 'another-image-model'},
    'gemini-image': {provider: 'google-ai-studio', model: 'gemini-2.5-flash-image'}
  });
  gatewayEnv.IMAGE_DEFAULT_MODEL = 'gemini-image';
  const listed = await (await get('/v1/models')).json();
  assert.equal(listed.defaultModel, 'gemini-image');
  assert.equal(listed.models.find(m => m.id === 'gemini-image').provider, 'google-ai-studio');
  assert.equal(JSON.stringify(listed).includes('synthetic'), false);
  assert.equal((await worker.fetch(new Request('https://example.test/v1/models'), gatewayEnv)).status, 401);
  assert.equal((await worker.fetch(generateRequest('gpt-image-2.5-flare'), gatewayEnv)).status, 200);
  assert.equal(gatewayPayload.model, 'another-image-model');
  const beforeRecovery = gatewayCalls;
  response = await worker.fetch(generateRequest('gpt-image-2.5-flare', gatewayID), gatewayEnv);
  assert.equal(response.status, 200);
  assert.equal(gatewayCalls, beforeRecovery, 'Remapping must not repeat an existing paid generation.');
  assert.equal(JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics'))).upstreamModel, 'gpt-image-2.5-flare');
  response = await worker.fetch(generateRequest('gpt-image-2.5-flare', gatewayID, {subject: 'Changed subject'}), gatewayEnv);
  assert.equal(response.status, 409);
  const googleResponse = {candidates: [{content: {parts: [
    {thought: true, inlineData: {mimeType: 'image/png', data: 'invalid-thought-image'}},
    {text: 'Here is the sheet'}, {inlineData: {mimeType: 'image/png', data: png}}
  ]}}], usageMetadata: {promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9}};
  globalThis.fetch = async (url, init) => {
    gatewayCalls++; gatewayURL = url; gatewayHeaders = new Headers(init.headers); gatewayPayload = JSON.parse(init.body);
    return Response.json(googleResponse);
  };
  response = await worker.fetch(generateRequest(), gatewayEnv);
  assert.equal(response.status, 200);
  assert.equal(gatewayURL, 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/coloring-sheets/google-ai-studio/v1/models/gemini-2.5-flash-image:generateContent');
  assert.equal(gatewayHeaders.has('Authorization'), false); assert.equal(gatewayHeaders.has('x-goog-api-key'), false);
  assert.equal(gatewayHeaders.get('cf-aig-authorization'), 'Bearer synthetic-gateway-token');
  assert.equal(gatewayPayload.generationConfig.imageConfig.aspectRatio, '3:2');
  assert.match(gatewayPayload.contents[0].parts[0].text, /child-appropriate/);
  assert.equal(gatewayPayload.quality, undefined);
  metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
  assert.equal(metrics.requestedModel, 'gemini-image'); assert.equal(metrics.provider, 'google-ai-studio');
  assert.equal(metrics.inputTokens, 4); assert.equal(metrics.outputTokens, 5); assert.equal(metrics.totalTokens, 9);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), savedBytes);
  gatewayEnv.AI_GATEWAY_KEY_SOURCE = 'worker'; gatewayEnv.GOOGLE_AI_STUDIO_API_KEY = 'synthetic-google-key';
  response = await worker.fetch(generateRequest('gemini-image', crypto.randomUUID(), {width: 1024, height: 1456}), gatewayEnv);
  assert.equal(response.status, 200); assert.equal(gatewayHeaders.get('x-goog-api-key'), 'synthetic-google-key');
  assert.equal(gatewayHeaders.has('Authorization'), false); assert.equal(gatewayPayload.generationConfig.imageConfig.aspectRatio, '2:3');
  gatewayEnv.AI_GATEWAY_KEY_SOURCE = 'gateway';
  const gatewayAccount = gatewayEnv.ACCOUNTS.objects.get(gatewayIdentity.accountId);
  const beforeBadConfig = await gatewayAccount.access(), beforeBadConfigCalls = gatewayCalls;
  const baseConfig = {...gatewayEnv};
  const invalidConfigs = [
    {AI_GATEWAY_ID: undefined}, {AI_GATEWAY_TOKEN: undefined}, {AI_GATEWAY_ACCOUNT_ID: 'not-an-account'},
    {AI_GATEWAY_TOKEN: 'invalid\nheader'}, {AI_GATEWAY_TOKEN: ' '},
    {AI_GATEWAY_ID: '../other-gateway'}, {AI_GATEWAY_KEY_SOURCE: 'unknown'},
    {AI_GATEWAY_KEY_SOURCE: 'worker', GOOGLE_AI_STUDIO_API_KEY: undefined},
    {IMAGE_MODEL_ROUTES: '{'}, {IMAGE_MODEL_ROUTES: 'null'}, {IMAGE_MODEL_ROUTES: '[]'},
    {IMAGE_MODEL_ROUTES: JSON.stringify({x: {provider: 'unsupported', model: 'image'}})},
    {IMAGE_MODEL_ROUTES: JSON.stringify({x: {provider: 'openai', model: '../images'}})},
    {IMAGE_MODEL_ROUTES: JSON.stringify({x: {provider: 'openai', model: 'image', url: 'https://example.test'}})},
    {IMAGE_DEFAULT_MODEL: 'not-allowed'}
  ];
  for (const overrides of invalidConfigs) {
    response = await worker.fetch(generateRequest(), {...baseConfig, ...overrides});
    assert.equal(response.status, 503, JSON.stringify(overrides));
  }
  for (const model of ['unknown-model', '__proto__', 'constructor', {}, 'https://example.test']) {
    assert.equal((await worker.fetch(generateRequest(model), gatewayEnv)).status, 400);
  }
  assert.equal(gatewayCalls, beforeBadConfigCalls);
  assert.deepEqual(await gatewayAccount.access(), beforeBadConfig, 'Invalid configuration/models must not spend allowance.');
  assert.equal(gatewayEnv.GENERATIONS.values.size, beforeBadConfigCalls);
  // Account access, renewal, and saved results do not depend on provider configuration.
  const brokenEnv = {...gatewayEnv, AI_GATEWAY_TOKEN: undefined, IMAGE_MODEL_ROUTES: '{'};
  assert.equal((await worker.fetch(new Request('https://example.test/v1/access', {headers: auth}), brokenEnv)).status, 200);
  assert.equal((await worker.fetch(renewRequest(gatewayIdentity.accessToken), brokenEnv)).status, 200);
  assert.equal((await worker.fetch(generateRequest('gpt-image-2.5-flare', gatewayID), brokenEnv)).status, 200);
  assert.equal((await get('/v1/generations/' + gatewayID)).status, 200);
  // HTTP, transport, timeout, malformed JSON, safety/text-only, and non-PNG failures
  // all become terminal jobs; raw upstream messages never leak to clients.
  const failures = [
    () => new Response(null, {status: 302, headers: {Location: 'https://other.example.test/'}}),
    () => Response.json({error: {message: 'private-provider-detail'}}, {status: 401}),
    () => Response.json({error: 'private-provider-detail'}, {status: 429}),
    () => new Response('private-provider-detail', {status: 503}),
    () => { throw new Error('private-provider-detail'); },
    () => { throw new DOMException('private-provider-detail', 'TimeoutError'); },
    () => new Response('not-json'),
    () => Response.json({candidates: [{content: {parts: [{text: 'private-provider-detail'}]}}]}),
    () => Response.json({candidates: [{content: {parts: [null]}}]}),
    () => Response.json({candidates: [{content: {parts: [{inlineData: {mimeType: 'image/jpeg', data: png}}]}}]}),
    () => Response.json({candidates: [{content: {parts: [{inlineData: {mimeType: 'image/png', data: 'broken-base64!'}}]}}]}),
    () => Response.json({candidates: [{content: {parts: [{inlineData: {mimeType: 'image/png', data: btoa('not an image')}}]}}]})
  ];
  for (const makeResponse of failures) {
    let failedCalls = 0;
    globalThis.fetch = async () => { failedCalls++; return makeResponse(); };
    const id = crypto.randomUUID();
    response = await worker.fetch(generateRequest('gemini-image', id), gatewayEnv);
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('private-provider-detail'), false);
    assert.equal((await get('/v1/generations/' + id)).status, 502);
    assert.equal((await worker.fetch(generateRequest('gemini-image', id), gatewayEnv)).status, 502);
    assert.equal(failedCalls, 1, 'Failures never fall back, retry upstream, or stay processing forever.');
  }
  // Native Cloudflare inference uses multipart through Gateway, with no OpenAI key.
  let nativeCalls = 0, conversions = 0, nativeURL, nativeForm, nativeOptions;
  const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16]);
  const nativeEnv = {...gatewayEnv, OPENAI_API_KEY: undefined, AI_GATEWAY_KEY_SOURCE: 'gateway',
    WORKERS_AI_API_TOKEN: 'synthetic-workers-ai-key',
    IMAGES: {input(stream) { return {async output(options) {
      conversions++;
      assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), jpeg);
      assert.deepEqual(options, {format: 'image/png'});
      return {response: () => new Response(Buffer.from(png, 'base64'), {headers: {'Content-Type': 'image/png'}})};
    }}; }}
  };
  const nativeFetch = async (url, options) => {
    nativeCalls++; nativeURL = url; nativeOptions = options;
    nativeForm = await new Response(options.body).formData();
    return Response.json({success: true, result: {image: btoa(String.fromCharCode(...jpeg))}});
  };
  globalThis.fetch = nativeFetch;
  for (const [model, width, height, expectedWidth, expectedHeight] of [
    ['flux-2-klein-4b', 1456, 1024, '1456', '1024'],
    ['flux-2-klein-9b', 2304, 1600, '1920', '1328'],
    ['flux-2-klein-4b', 1600, 2304, '1328', '1920'],
    ['flux-2-dev', 1600, 2304, '1328', '1920']
  ]) {
    const id = crypto.randomUUID(), before = (await gatewayAccount.access()).freeGenerationsRemaining;
    response = await worker.fetch(generateRequest(model, id, {width, height}), nativeEnv);
    assert.equal(response.status, 200);
    assert.equal(nativeURL, 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/coloring-sheets/workers-ai/@cf/black-forest-labs/' + model);
    assert.equal(nativeForm.get('width'), expectedWidth); assert.equal(nativeForm.get('height'), expectedHeight);
    assert.match(nativeForm.get('prompt'), /child-appropriate.*Synthetic flower/);
    assert.deepEqual([...nativeForm.keys()].sort(), model === 'flux-2-dev' ? ['height', 'prompt', 'steps', 'width'] : ['height', 'prompt', 'width']);
    if (model === 'flux-2-dev') assert.equal(nativeForm.get('steps'), '25');
    assert.equal(nativeOptions.headers.Authorization, 'Bearer synthetic-workers-ai-key');
    assert.equal(nativeOptions.headers['cf-aig-authorization'], 'Bearer synthetic-gateway-token');
    assert.equal(nativeOptions.headers['cf-aig-max-attempts'], '1');
    assert.equal(nativeOptions.headers['cf-aig-skip-cache'], 'true');
    assert.equal(nativeOptions.headers['Content-Type'], undefined, 'fetch must supply the multipart boundary');
    assert.equal(nativeOptions.redirect, 'manual');
    assert.ok(nativeOptions.signal instanceof AbortSignal);
    metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
    assert.equal(metrics.provider, 'workers-ai'); assert.equal(metrics.viaGateway, true);
    assert.equal(metrics.requestedSize, width + 'x' + height); assert.equal(metrics.size, '1x1');
    assert.equal(metrics.upstreamModel, '@cf/black-forest-labs/' + model); assert.equal(metrics.totalTokens, null);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), savedBytes);
    const attempts = nativeCalls;
    assert.equal((await worker.fetch(generateRequest(model, id, {width, height}), nativeEnv)).status, 200);
    assert.deepEqual(new Uint8Array(await (await get('/v1/generations/' + id)).arrayBuffer()), savedBytes);
    assert.equal(nativeCalls, attempts); assert.equal(conversions, attempts, 'Recovery does not convert or generate again.');
    assert.equal((await gatewayAccount.access()).freeGenerationsRemaining, before - 1);
  }
  const nativeBeforeBadConfig = await gatewayAccount.access();
  for (const changes of [{AI_GATEWAY_TOKEN: undefined}, {WORKERS_AI_API_TOKEN: undefined},
    {WORKERS_AI_API_TOKEN: nativeEnv.AI_GATEWAY_TOKEN}, {WORKERS_AI_API_TOKEN: 'invalid\nkey'},
    {AI_GATEWAY_ACCOUNT_ID: undefined}, {IMAGES: undefined}, {AI_GATEWAY_ID: undefined},
    {IMAGE_MODEL_ROUTES: JSON.stringify({bad: {provider: 'workers-ai', model: '@cf/unsupported'}})}]) {
    assert.equal((await worker.fetch(generateRequest('flux-2-klein-4b'), {...nativeEnv, ...changes})).status, 503);
  }
  assert.deepEqual(await gatewayAccount.access(), nativeBeforeBadConfig);
  // A separate Workers AI credential stays separate from Gateway authentication.
  // Providers returning PNG in future must not need another transformation.
  const conversionsBeforePNG = conversions;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-workers-ai-key');
    assert.equal(options.headers['cf-aig-authorization'], 'Bearer synthetic-gateway-token');
    return Response.json({result: {image: png}});
  };
  response = await worker.fetch(generateRequest('flux-2-klein-4b'), {...nativeEnv, WORKERS_AI_API_TOKEN: 'synthetic-workers-ai-key'});
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), savedBytes);
  assert.equal(conversions, conversionsBeforePNG);
  for (const result of [null, {image: '!'}, {image: btoa('not an image')}, new Error('private-provider-detail')]) {
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; if (result instanceof Error) throw result; return Response.json(result); };
    const failingEnv = nativeEnv;
    const id = crypto.randomUUID();
    response = await worker.fetch(generateRequest('flux-2-klein-4b', id), failingEnv);
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('private-provider-detail'));
    assert.equal((await worker.fetch(generateRequest('flux-2-klein-4b', id), failingEnv)).status, 502);
    assert.equal(attempts, 1);
  }
  globalThis.fetch = nativeFetch;
  const conversionFailureID = crypto.randomUUID(), callsBeforeConversionFailure = nativeCalls;
  const brokenImages = {...nativeEnv, IMAGES: {input() { throw new Error('private-conversion-detail'); }}};
  response = await worker.fetch(generateRequest('flux-2-klein-4b', conversionFailureID), brokenImages);
  assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('private-conversion-detail'));
  assert.equal((await worker.fetch(generateRequest('flux-2-klein-4b', conversionFailureID), nativeEnv)).status, 502);
  assert.equal(nativeCalls, callsBeforeConversionFailure + 1, 'Conversion failure cannot repeat paid inference.');

  // JSON-input native models: exercise both response protocols, fitting, auth,
  // actual dimensions, and recovery through the complete public API.
  const nativeModels = [
    ['flux-1-schnell', '@cf/black-forest-labs/flux-1-schnell', null, 'steps', 4, false],
    ['lucid-origin', '@cf/leonardo/lucid-origin', 2496, 'num_steps', 25, false],
    ['phoenix-1.0', '@cf/leonardo/phoenix-1.0', 2048, 'num_steps', 25, true],
    ['stable-diffusion-xl-base-1.0', '@cf/stabilityai/stable-diffusion-xl-base-1.0', 2048, 'num_steps', 20, true],
    ['stable-diffusion-xl-lightning', '@cf/bytedance/stable-diffusion-xl-lightning', 2048, 'num_steps', 4, true],
    ['dreamshaper-8-lcm', '@cf/lykon/dreamshaper-8-lcm', 2048, 'num_steps', 8, true]
  ];
  for (const [model, upstream, maxEdge, stepKey, steps, binary] of nativeModels) {
    for (const [width, height] of [[1456, 1024], [1024, 3072], [3072, 1024], [1024, 1024]]) {
      let attempts = 0;
      const before = (await gatewayAccount.access()).freeGenerationsRemaining, id = crypto.randomUUID();
      const conversionsBefore = conversions;
      globalThis.fetch = async (url, options) => {
        attempts++;
        assert.equal(url, 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/coloring-sheets/workers-ai/' + upstream);
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.equal(options.headers.Authorization, 'Bearer synthetic-workers-ai-key');
        assert.equal(options.headers['cf-aig-authorization'], 'Bearer synthetic-gateway-token');
        assert.equal(options.headers['cf-aig-skip-cache'], 'true');
        assert.equal(options.headers['cf-aig-max-attempts'], '1');
        assert.equal(options.redirect, 'manual');
        const payload = JSON.parse(options.body);
        assert.match(payload.prompt, /black outlines.*child-appropriate.*Synthetic flower/);
        assert.equal(payload[stepKey], steps);
        assert.equal(payload.model, undefined);
        if (maxEdge) {
          const scale = Math.min(1, maxEdge / Math.max(width, height));
          assert.equal(payload.width, Math.round(width * scale / 16) * 16);
          assert.equal(payload.height, Math.round(height * scale / 16) * 16);
          assert.ok(payload.width <= maxEdge && payload.height <= maxEdge);
        } else {
          assert.deepEqual(Object.keys(payload).sort(), ['prompt', 'steps'], 'Schnell must not receive unsupported dimensions.');
        }
        if (binary) assert.match(payload.negative_prompt, /shading.*text/);
        else assert.equal(payload.negative_prompt, undefined);
        return binary
          ? new Response(savedBytes, {headers: {'Content-Type': 'image/png'}})
          : Response.json({success: true, result: {image: btoa(String.fromCharCode(...jpeg))}});
      };
      response = await worker.fetch(generateRequest(model, id, {width, height}), nativeEnv);
      assert.equal(response.status, 200, model);
      assert.equal(response.headers.get('Content-Type'), 'image/png');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), savedBytes);
      metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
      assert.equal(metrics.requestedModel, model); assert.equal(metrics.upstreamModel, upstream);
      assert.equal(metrics.provider, 'workers-ai'); assert.equal(metrics.viaGateway, true);
      assert.equal(metrics.requestedSize, width + 'x' + height); assert.equal(metrics.size, '1x1');
      assert.equal(metrics.totalTokens, null); assert.equal(metrics.estimatedTotalUsd ?? null, null);
      assert.equal((await worker.fetch(generateRequest(model, id, {width, height}), nativeEnv)).status, 200);
      assert.deepEqual(new Uint8Array(await (await get('/v1/generations/' + id)).arrayBuffer()), savedBytes);
      assert.equal(attempts, 1); assert.equal(conversions, conversionsBefore + (binary ? 0 : 1));
      assert.equal((await gatewayAccount.access()).freeGenerationsRemaining, before - 1);
    }
    const before = await gatewayAccount.access();
    globalThis.fetch = async () => { assert.fail('Missing credentials must not invoke the provider.'); };
    assert.equal((await worker.fetch(generateRequest(model), {...nativeEnv, WORKERS_AI_API_TOKEN: undefined})).status, 503);
    assert.deepEqual(await gatewayAccount.access(), before);
  }
  // Binary JPEG is converted; unwrapped JSON and octet-stream PNG are accepted.
  for (const upstreamResponse of [
    () => new Response(jpeg, {headers: {'Content-Type': 'image/jpeg; charset=binary'}}),
    () => new Response(savedBytes, {headers: {'Content-Type': 'application/octet-stream'}}),
    () => Response.json({image: png})
  ]) {
    globalThis.fetch = async () => upstreamResponse();
    response = await worker.fetch(generateRequest('phoenix-1.0'), nativeEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), savedBytes);
  }
  // Neither an image MIME label nor a successful HTTP status proves valid output.
  for (const upstreamResponse of [
    () => new Response('private-provider-detail', {headers: {'Content-Type': 'image/png'}}),
    () => new Response('private-provider-detail', {headers: {'Content-Type': 'text/html'}}),
    () => Response.json({success: false, result: {image: png}}),
    () => Response.json({result: {image: '!'}}),
    () => new Response('private-provider-detail', {status: 429}),
    () => new Response('private-provider-detail', {status: 500})
  ]) {
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return upstreamResponse(); };
    const id = crypto.randomUUID();
    response = await worker.fetch(generateRequest('phoenix-1.0', id), nativeEnv);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('private-provider-detail'));
    assert.equal((await worker.fetch(generateRequest('phoenix-1.0', id), nativeEnv)).status, 502);
    assert.equal((await get('/v1/generations/' + id)).status, 502);
    assert.equal(attempts, 1, 'Binary/JSON native failures cannot repeat paid inference.');
  }
  env.GLOBAL_DAILY_GENERATION_LIMIT = '0';
  env.BUDGET = new BudgetNamespace(env);
  response = await worker.fetch(new Request('https://example.test/v1/generations', {method: 'POST', headers: {
    'Authorization': 'Bearer ' + identity.accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()
  }, body: JSON.stringify({subject: 'Synthetic flower'})}), env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'service_budget_exhausted', 'Keep service and personal limits distinct.');
  assert.deepEqual(await storedAccount.access(), beforeRenewal, 'A full service budget cannot spend account credits.');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: registration/renewal, expiry/revocation, retained accounts and jobs, generation, concurrent reservations, idempotency, service/personal budgets, AI Gateway BYOK modes, model routing, Gemini PNG/metrics, all nine Workers AI routes, multipart/JSON inputs, binary/base64 PNG conversion, size fitting, and terminal provider failures; no network.');
