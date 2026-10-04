import {MODERATION_MODELS, MODERATION_POLICY, moderateSubject, moderationThresholds} from '../../coloring-sheets-api/src/moderation.mjs';
const json = (value, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const COOKIE = '__Host-lab_session';
const MAX_AGE = 30 * 24 * 60 * 60;
const cookieHeader = (value, age = MAX_AGE) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
async function signature(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
async function equal(a, b) {
  const hash = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  let mismatch = 0; for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}
async function authenticated(request, env) {
  if (!env.LAB_ACCESS_KEY) return false;
  const token = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token || !/^\d+\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, mac] = token.split('.');
  const now = Math.floor(Date.now() / 1000);
  return Number(expires) > now && Number(expires) <= now + MAX_AGE && await equal(mac, await signature(env.LAB_ACCESS_KEY, expires));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config' && request.method === 'GET') return json({policy: MODERATION_POLICY, models: Object.entries(MODERATION_MODELS).map(([name, id]) => ({name, id, thresholds: moderationThresholds(id)}))});
    if (!['/api/compare', '/api/session'].includes(url.pathname)) return json({error: 'Not found'}, 404);
    if (url.pathname === '/api/session' && request.method === 'GET') return json({authenticated: await authenticated(request, env)});
    if (!['POST', 'DELETE'].includes(request.method) || (url.pathname === '/api/compare' && request.method !== 'POST')) return json({error: 'Use POST'}, 405);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({error: 'Invalid origin'}, 403);
    if (url.pathname === '/api/session' && request.method === 'DELETE') {
      if (request.headers.get('Origin') !== url.origin) return json({error: 'Invalid origin'}, 403);
      const response = json({authenticated: false}); response.headers.set('Set-Cookie', cookieHeader('', 0)); return response;
    }
    if (!env.LAB_ACCESS_KEY) return json({error: 'Access key is not configured'}, 503);
    const bearer = await equal(request.headers.get('Authorization') ?? '', 'Bearer ' + env.LAB_ACCESS_KEY);
    const session = await authenticated(request, env);
    if (!bearer && !session) return json({error: 'Enter the correct lab access key'}, 401);
    if (session && !bearer && request.headers.get('Origin') !== url.origin) return json({error: 'Invalid origin'}, 403);
    if (url.pathname === '/api/session') {
      if (!bearer) return json({error: 'Enter the correct lab access key'}, 401);
      const expires = String(Math.floor(Date.now() / 1000) + MAX_AGE);
      const response = json({authenticated: true});
      response.headers.set('Set-Cookie', cookieHeader(expires + '.' + await signature(env.LAB_ACCESS_KEY, expires)));
      return response;
    }
    if (Number(request.headers.get('Content-Length')) > 16384) return json({error: 'Request too large'}, 413);
    let input;
    try {
      const raw = await request.text();
      if (raw.length > 16384) return json({error: 'Request too large'}, 413);
      input = JSON.parse(raw);
    } catch { return json({error: 'Invalid JSON'}, 400); }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) return json({error: 'Enter a prompt of 1–4,000 characters'}, 400);
    if (!env.LIMITER || !(await env.LIMITER.limit({key: 'lab'})).success) return json({error: 'Comparison limit reached. Try again in a minute.'}, 429);
    const results = await Promise.all(Object.entries(MODERATION_MODELS).map(async ([name, id]) => {
      const base = {name, id, thresholds: moderationThresholds(id)};
      try {
        const diagnostics = await moderateSubject({...env, MODERATION_MODEL: name}, input.prompt);
        return {...base, outcome: 'approved', allowed: true, reasonCodes: [], ...diagnostics};
      } catch (error) {
        if (error.code === 'description_not_suitable') return {...base, outcome: 'rejected', allowed: false, reasonCodes: error.reasonCodes, ...error.diagnostics};
        return {...base, outcome: 'unavailable', allowed: null, failure: error.diagnostics?.failure ?? 'upstream', elapsedMs: error.diagnostics?.elapsedMs ?? 0};
      }
    }));
    return json({prompt: input.prompt, policy: MODERATION_POLICY, comparedAt: new Date().toISOString(), results});
  }
};
