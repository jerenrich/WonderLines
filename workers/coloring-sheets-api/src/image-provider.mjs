// Provider-native image APIs behind AI Gateway. Public model IDs are an allowlist,
// never URLs, credentials, or arbitrary upstream request bodies from a client.
export const DEFAULT_MODEL = 'gpt-image-2.5-flare';
const DEFAULT_ROUTES = {
  'gpt-image-2.5-flare': {provider: 'openai', model: 'gpt-image-2.5-flare'},
  'gpt-image-2.5-sunburst': {provider: 'openai', model: 'gpt-image-2.5-sunburst'},
  'flux-2-klein-4b': {provider: 'workers-ai', model: '@cf/black-forest-labs/flux-2-klein-4b'},
  'flux-2-klein-9b': {provider: 'workers-ai', model: '@cf/black-forest-labs/flux-2-klein-9b'},
  'flux-2-dev': {provider: 'workers-ai', model: '@cf/black-forest-labs/flux-2-dev'},
  'flux-1-schnell': {provider: 'workers-ai', model: '@cf/black-forest-labs/flux-1-schnell'},
  'lucid-origin': {provider: 'workers-ai', model: '@cf/leonardo/lucid-origin'},
  'phoenix-1.0': {provider: 'workers-ai', model: '@cf/leonardo/phoenix-1.0'},
  'stable-diffusion-xl-base-1.0': {provider: 'workers-ai', model: '@cf/stabilityai/stable-diffusion-xl-base-1.0'},
  'stable-diffusion-xl-lightning': {provider: 'workers-ai', model: '@cf/bytedance/stable-diffusion-xl-lightning'},
  'dreamshaper-8-lcm': {provider: 'workers-ai', model: '@cf/lykon/dreamshaper-8-lcm'}
};
const PROVIDERS = ['openai', 'google-ai-studio', 'workers-ai'];
// Native models have different input protocols; only enable those this adapter supports.
const NEGATIVE_PROMPT = 'color, shading, grayscale, gradients, shadows, photographs, text, letters, watermarks';
// Per-model protocols and limits from Cloudflare's model docs (2026-09-23).
// Schnell has no documented dimensions input: preserve its native output size.
const WORKERS_AI_MODELS = new Map([
  ['@cf/black-forest-labs/flux-2-klein-4b', {multipart: true, maxEdge: 1920}],
  ['@cf/black-forest-labs/flux-2-klein-9b', {multipart: true, maxEdge: 1920}],
  ['@cf/black-forest-labs/flux-2-dev', {multipart: true, maxEdge: 1920, parameters: {steps: 25}}],
  ['@cf/black-forest-labs/flux-1-schnell', {parameters: {steps: 4}}],
  ['@cf/leonardo/lucid-origin', {maxEdge: 2496, parameters: {num_steps: 25}}],
  ['@cf/leonardo/phoenix-1.0', {maxEdge: 2048, parameters: {num_steps: 25, negative_prompt: NEGATIVE_PROMPT}}],
  ['@cf/stabilityai/stable-diffusion-xl-base-1.0', {maxEdge: 2048, parameters: {num_steps: 20, negative_prompt: NEGATIVE_PROMPT}}],
  ['@cf/bytedance/stable-diffusion-xl-lightning', {maxEdge: 2048, parameters: {num_steps: 4, negative_prompt: NEGATIVE_PROMPT}}],
  ['@cf/lykon/dreamshaper-8-lcm', {maxEdge: 2048, parameters: {num_steps: 8, negative_prompt: NEGATIVE_PROMPT}}]
]);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
const PROMPT = 'Create a printable coloring page with bold clean black outlines on a pure white background, enclosed areas to color, and generous white margins. Follow any complexity guidance in the subject description. No shading, gray, colors, text, or watermarks. Friendly, gentle, child-appropriate imagery only. Subject and complexity guidance: ';

export function modelCatalog(env) {
  const overrides = env.IMAGE_MODEL_ROUTES === undefined ? {} : JSON.parse(env.IMAGE_MODEL_ROUTES);
  if (!object(overrides)) throw new Error('Invalid image model routes');
  const routes = {...DEFAULT_ROUTES, ...overrides};
  if (Object.keys(routes).length > 32) throw new Error('Too many image model routes');
  for (const [id, route] of Object.entries(routes)) {
    if (!identifier(id) || !object(route) || !PROVIDERS.includes(route.provider) ||
        !(route.provider === 'workers-ai' ? WORKERS_AI_MODELS.has(route.model) : identifier(route.model)) ||
        Object.keys(route).some(key => !['provider', 'model'].includes(key))) throw new Error('Invalid image model route');
  }
  const defaultModel = env.IMAGE_DEFAULT_MODEL ?? DEFAULT_MODEL;
  if (!identifier(defaultModel) || !Object.hasOwn(routes, defaultModel)) throw new Error('Invalid default model');
  return {defaultModel, routes};
}

// An absent gateway preserves existing deployments. Partial configuration fails
// closed; a gateway failure never triggers a second, direct paid request.
function transport(env, provider) {
  const configured = [env.AI_GATEWAY_ACCOUNT_ID, env.AI_GATEWAY_ID, env.AI_GATEWAY_TOKEN, env.AI_GATEWAY_KEY_SOURCE]
    .some(value => value !== undefined);
  const headers = {'Content-Type': 'application/json'};
  const keySource = env.AI_GATEWAY_KEY_SOURCE ?? 'worker';
  let base;
  if (configured) {
    if (!/^[a-fA-F0-9]{32}$/.test(env.AI_GATEWAY_ACCOUNT_ID ?? '') || !identifier(env.AI_GATEWAY_ID) ||
        !secret(env.AI_GATEWAY_TOKEN) || !['worker', 'gateway'].includes(keySource)) throw new Error('Invalid gateway configuration');
    base = `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${provider}`;
    headers['cf-aig-authorization'] = 'Bearer ' + env.AI_GATEWAY_TOKEN;
    // Each new job should produce a fresh sheet and consume at most one attempt.
    headers['cf-aig-skip-cache'] = 'true';
    headers['cf-aig-max-attempts'] = '1';
  } else {
    if (provider !== 'openai') throw new Error('This provider requires AI Gateway');
    base = 'https://api.openai.com/v1';
  }
  if (keySource === 'worker') {
    const apiKey = provider === 'openai' ? env.OPENAI_API_KEY : env.GOOGLE_AI_STUDIO_API_KEY;
    if (!secret(apiKey)) throw new Error('Missing provider key');
    headers[provider === 'openai' ? 'Authorization' : 'x-goog-api-key'] = (provider === 'openai' ? 'Bearer ' : '') + apiKey;
  }
  // Stored BYOK must OMIT the provider authorization header, even if an old
  // OPENAI_API_KEY secret remains on the Worker during migration.
  return {base, headers, viaGateway: configured};
}

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
function closestAspectRatio({width, height}) {
  const distance = ratio => { const [w, h] = ratio.split(':').map(Number); return Math.abs(Math.log((width / height) / (w / h))); };
  return ASPECT_RATIOS.reduce((best, ratio) => distance(ratio) < distance(best) ? ratio : best);
}

// Build and validate everything that can fail locally before spending allowance.
export function imageRequest(env, route, subject, size) {
  const prompt = PROMPT + subject.trim();
  if (route.provider === 'workers-ai') {
    const token = env.WORKERS_AI_API_TOKEN;
    if (!WORKERS_AI_MODELS.has(route.model) || !identifier(env.AI_GATEWAY_ID) ||
        !/^[a-fA-F0-9]{32}$/.test(env.AI_GATEWAY_ACCOUNT_ID ?? '') ||
        !secret(env.AI_GATEWAY_TOKEN) || !secret(token) || token === env.AI_GATEWAY_TOKEN ||
        typeof env.IMAGES?.input !== 'function') {
      throw new Error('Missing Workers AI, Images, or gateway configuration');
    }
    const config = WORKERS_AI_MODELS.get(route.model);
    const parameters = {prompt, ...config.parameters};
    if (config.maxEdge) {
      const scale = Math.min(1, config.maxEdge / Math.max(size.width, size.height));
      for (const edge of ['width', 'height']) parameters[edge] = Math.max(256, Math.round(size[edge] * scale / 16) * 16);
    }
    let payload = parameters;
    if (config.multipart) {
      payload = new FormData();
      for (const [key, value] of Object.entries(parameters)) payload.set(key, String(value));
    }
    // AI.run() currently rejects multipart streams with gateway options. Use the
    // provider-native Gateway endpoint; fetch supplies the FormData boundary.
    return {provider: route.provider, model: route.model, viaGateway: true, images: env.IMAGES, payload,
      url: `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/workers-ai/${route.model}`,
      headers: {...(config.multipart ? {} : {'Content-Type': 'application/json'}),
        Authorization: 'Bearer ' + token, 'cf-aig-authorization': 'Bearer ' + env.AI_GATEWAY_TOKEN,
        'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1'}};
  }
  const {base, headers, viaGateway} = transport(env, route.provider);
  const path = route.provider === 'openai' ? '/images/generations' : `/v1/models/${route.model}:generateContent`;
  const payload = route.provider === 'openai'
    ? {model: route.model, n: 1, size: `${size.width}x${size.height}`, quality: 'low', output_format: 'png', prompt}
    : {contents: [{role: 'user', parts: [{text: prompt}]}], generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'], imageConfig: {aspectRatio: closestAspectRatio(size)}
    }};
  return {url: base + path, headers, payload, provider: route.provider, model: route.model, viaGateway};
}

export class ImageProviderError extends Error {
  constructor(message, code = 'provider_invalid_response') { super(message); this.code = code; }
}
const INVALID_IMAGE = 'The image provider returned an unreadable or missing image. Try another model or check the provider status.';
const providerName = provider => ({openai: 'OpenAI', 'workers-ai': 'Cloudflare Workers AI', 'google-ai-studio': 'Google AI Studio'})[provider];

// Read only a small error envelope. Provider text may echo prompts, credentials,
// or internal diagnostics: use it to classify errors, never forward it verbatim.
async function errorBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = []; let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) { await reader.cancel(); return {}; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
  finally { reader.releaseLock(); }
}

function providerFailure(request, status, body) {
  const name = providerName(request.provider);
  const errors = [body?.error, ...(Array.isArray(body?.errors) ? body.errors : [])].filter(Boolean);
  const codes = errors.flatMap(error => [error.code, error.type, error.status]).map(String);
  const messages = errors.map(error => typeof error === 'string' ? error : error.message ?? '').join(' ').toLowerCase();
  const known = (...values) => values.some(value => codes.includes(value));
  const detail = status >= 400 ? ` (HTTP ${status})` : '';
  const failure = (code, message, suffix = detail) => new ImageProviderError(message + suffix + '.', code);
  if (request.provider === 'workers-ai' && (known('4006') || /daily free allocation.*10,?000 neurons/.test(messages))) {
    return failure('provider_daily_quota_exhausted',
      'Cloudflare Workers AI has used its daily free allowance of 10,000 neurons. It resets at 00:00 UTC. Choose Flare or Sunburst to use OpenAI, or upgrade the Cloudflare Workers plan',
      status >= 400 ? ` (HTTP ${status}; Cloudflare code 4006)` : ' (Cloudflare code 4006)');
  }
  if (known('insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active') || /insufficient.{0,20}(credit|quota)|billing.{0,20}limit/.test(messages)) {
    return failure('provider_quota_exhausted', `${name} reports exhausted credits or quota. Check that provider’s billing and usage limits, or choose another provider`);
  }
  if (known('content_policy_violation', 'safety_violations', 'IMAGE_SAFETY', 'SAFETY') || /content policy|safety filter/.test(messages)) {
    return failure('provider_content_rejected', `${name} rejected this description under its content rules. Revise the description`);
  }
  if (status === 401 || known('invalid_api_key', 'UNAUTHENTICATED')) {
    return failure('provider_authentication_failed', `${name} or AI Gateway rejected the service credentials. The developer needs to check the server’s API keys`);
  }
  if (status === 403 || known('PERMISSION_DENIED')) {
    return failure('provider_access_denied', `${name} or AI Gateway denied access. The developer needs to check token permissions and model access`);
  }
  if (status === 404 || known('model_not_found', 'NOT_FOUND')) {
    return failure('provider_model_unavailable', `${name} could not find or grant access to the selected model. Choose another model or check model access`);
  }
  if (status === 429 || known('rate_limit_exceeded', 'RESOURCE_EXHAUSTED')) {
    return failure('provider_rate_limited', `${name} or AI Gateway has reached a request or usage limit. Wait before retrying, or check the provider’s limits`);
  }
  if (status === 408 || status === 504) {
    return failure('provider_timeout', `${name} timed out. Generation may have been charged; check usage before starting another request`);
  }
  if (status >= 500) return failure('provider_unavailable', `${name} or AI Gateway is temporarily unavailable. Try again later`);
  if ([400, 413, 422].includes(status)) {
    return failure('provider_request_rejected', `${name} rejected the description, image size, or model parameters. Revise the description or choose another model`);
  }
  return failure('upstream_failed', `${name} could not complete the image request. Check the provider or Gateway logs for this failure`);
}

function decodeBase64(encoded) {
  if (typeof encoded !== 'string' || !encoded) throw new ImageProviderError(INVALID_IMAGE);
  try { return Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); }
  catch { throw new ImageProviderError(INVALID_IMAGE); }
}

function decodePNG(image) {
  // Validate the header and read the actual size; never label JPEG/text as PNG.
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (image.length < 33 || !signature.every((byte, index) => image[index] === byte) ||
      new DataView(image.buffer).getUint32(8) !== 13 ||
      String.fromCharCode(...image.slice(12, 16)) !== 'IHDR') throw new ImageProviderError(INVALID_IMAGE);
  const view = new DataView(image.buffer), width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height) throw new ImageProviderError(INVALID_IMAGE);
  return {image, size: `${width}x${height}`};
}

export async function runImageRequest(request) {
  let response;
  try {
    // workerd supports "manual", not "error". Reject redirects via !ok below
    // so provider credentials are never forwarded to a redirect destination.
    response = await fetch(request.url, {method: 'POST', headers: request.headers,
      body: request.payload instanceof FormData ? request.payload : JSON.stringify(request.payload), redirect: 'manual', signal: AbortSignal.timeout(180000)});
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ImageProviderError(`${providerName(request.provider)} ${timeout ? 'timed out' : 'could not be reached'}. Generation may have been charged; check usage before starting another request.`,
      timeout ? 'provider_timeout' : 'provider_connection_failed');
  }
  if (!response.ok) throw providerFailure(request, response.status, await errorBody(response));
  if (request.provider === 'workers-ai') {
    let image;
    try {
      const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      // Phoenix and Stable Diffusion return binary images; FLUX and Lucid use JSON.
      if (['image/png', 'image/jpeg', 'application/octet-stream'].includes(type)) {
        image = new Uint8Array(await response.arrayBuffer());
      } else {
        const upstream = await response.json();
        if (upstream?.success === false || upstream?.error) throw providerFailure(request, response.status, upstream);
        image = decodeBase64(upstream?.result?.image ?? upstream?.image);
      }
    } catch (error) {
      if (error instanceof ImageProviderError) throw error;
      throw new ImageProviderError(INVALID_IMAGE);
    }
    // Convert JPEG once before storing; recovery reuses the saved PNG.
    if (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
      try {
        const converted = await request.images.input(new Response(image).body).output({format: 'image/png'});
        const response = converted.response();
        if (!response.ok) throw new Error('Image conversion failed');
        image = new Uint8Array(await response.arrayBuffer());
      } catch { throw new ImageProviderError('The image was generated, but Cloudflare Images could not convert it to PNG. Check the Images service quota and status before generating again.', 'provider_image_conversion_failed'); }
    }
    return {...decodePNG(image), inputTokens: null, outputTokens: null, totalTokens: null};
  }
  let upstream;
  try { upstream = await response.json(); } catch { throw new ImageProviderError(INVALID_IMAGE); }
  if (upstream?.success === false || upstream?.error) throw providerFailure(request, response.status, upstream);
  let encodedImage, usage;
  if (request.provider === 'openai') {
    encodedImage = upstream?.data?.[0]?.b64_json;
    usage = upstream?.usage;
  } else {
    const reason = upstream?.promptFeedback?.blockReason ?? upstream?.candidates?.[0]?.finishReason;
    if (['SAFETY', 'IMAGE_SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(reason)) {
      throw providerFailure(request, response.status, {error: {code: 'SAFETY'}});
    }
    const parts = upstream?.candidates?.[0]?.content?.parts;
    const part = Array.isArray(parts) ? parts.find(part => !part?.thought && part?.inlineData?.mimeType === 'image/png') : null;
    encodedImage = part?.inlineData?.data;
    usage = {input_tokens: upstream?.usageMetadata?.promptTokenCount,
      output_tokens: upstream?.usageMetadata?.candidatesTokenCount, total_tokens: upstream?.usageMetadata?.totalTokenCount};
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {...decodePNG(decodeBase64(encodedImage)), inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens), totalTokens: count(usage?.total_tokens)};
}
