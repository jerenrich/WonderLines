import {SignJWT, jwtVerify, createRemoteJWKSet} from 'jose';
import {equal} from './auth.mjs';

import {ADMIN_EMAIL} from '../../shared/admin-identity.mjs';
export {ADMIN_EMAIL};
export const ADMIN_PATH = '/admin/models';
export const CALLBACK_PATH = '/api/admin/auth/callback';
const SESSION = '__Host-wonderlines_admin';
const FLOW = '__Host-wonderlines_admin_oauth';
const COMPARE_SESSION = '__Host-wonderlines_compare_google';
const issuer = 'wonderlines-model-admin';
const encoder = new TextEncoder();
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 5000, cacheMaxAge: 3600000, cooldownDuration: 30000
});
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const adminCookie = (name, value = '', age = 0, sameSite = 'Strict') =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${age}`;
const cookie = (request, name) => request.headers.get('Cookie')?.split(';').map(value => value.trim())
  .find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const key = env => encoder.encode(env.MODEL_ADMIN_SESSION_SECRET);
const security = {'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff'};
function redirect(location, cookies = []) {
  const headers = new Headers({...security, Location: location});
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, {status:303, headers});
}
export function adminOrigin(env) {
  try {
    const url = new URL(env.MODEL_ADMIN_ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== env.MODEL_ADMIN_ORIGIN) return null;
    return url.origin;
  } catch { return null; }
}
export function adminConfigured(env) {
  return !!adminOrigin(env) && typeof env.GOOGLE_CLIENT_ID === 'string' &&
    /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID) &&
    typeof env.GOOGLE_CLIENT_SECRET === 'string' && env.GOOGLE_CLIENT_SECRET.length >= 8 &&
    typeof env.MODEL_ADMIN_SESSION_SECRET === 'string' && env.MODEL_ADMIN_SESSION_SECRET.length >= 32;
}
async function sign(env, payload, subject, duration) {
  return new SignJWT(payload).setProtectedHeader({alg:'HS256'}).setIssuer(issuer)
    .setAudience(env.GOOGLE_CLIENT_ID).setSubject(subject).setIssuedAt().setExpirationTime(duration).sign(key(env));
}
async function verifyLocal(env, token, purpose) {
  const {payload} = await jwtVerify(token, key(env), {algorithms:['HS256'], issuer, audience:env.GOOGLE_CLIENT_ID,
    requiredClaims:['exp','iat','sub'], maxTokenAge:purpose === 'oauth' ? '10m' : '8h'});
  if (payload.purpose !== purpose) throw new Error('Wrong cookie purpose');
  return payload;
}
async function sessionPrincipal(request, env, cookieName, purpose) {
  if (!adminConfigured(env)) return null;
  try {
    const token = cookie(request, cookieName);
    if (!token || token.length > 4096) return null;
    const payload = await verifyLocal(env, token, purpose);
    if (payload.email !== ADMIN_EMAIL || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) return null;
    return {id:payload.sub, email:ADMIN_EMAIL, role:'model-admin'};
  } catch { return null; }
}
// Accept the previous comparison cookie until it expires, so existing signed-in
// users can move between both sections without another Google round-trip.
export async function adminPrincipal(request, env) {
  return await sessionPrincipal(request, env, SESSION, 'session') ||
    await sessionPrincipal(request, env, COMPARE_SESSION, 'comparison-session');
}
export const comparisonPrincipal = adminPrincipal;
export async function verifyGoogleIdentity(token, env, nonce, keys = googleKeys) {
  const {payload} = await jwtVerify(token, keys, {algorithms:['RS256'],
    issuer:['https://accounts.google.com','accounts.google.com'], audience:env.GOOGLE_CLIENT_ID,
    requiredClaims:['exp','iat','sub','email','email_verified','nonce'], maxTokenAge:'10m'});
  if (payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.toLowerCase() !== ADMIN_EMAIL ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 ||
      typeof payload.nonce !== 'string' || !await equal(payload.nonce, nonce) ||
      Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== env.GOOGLE_CLIENT_ID ||
      payload.azp !== undefined && payload.azp !== env.GOOGLE_CLIENT_ID) throw new Error('Google account not authorized');
  return {id:payload.sub, email:ADMIN_EMAIL};
}
export async function beginAdminLogin(env, destination = 'admin') {
  const state = random(), nonce = random(), verifier = random();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const flow = await sign(env, {purpose:'oauth', state, nonce, verifier, destination:['comparison','safety'].includes(destination) ? destination : 'admin'}, 'oauth-flow', '10m');
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID, redirect_uri:adminOrigin(env)+CALLBACK_PATH,
    response_type:'code', scope:'openid email', state, nonce, code_challenge:challenge, code_challenge_method:'S256',
    login_hint:ADMIN_EMAIL, prompt:'select_account'}).toString();
  return redirect(target.href, [adminCookie(FLOW, flow, 600, 'Lax')]);
}
export async function finishAdminLogin(request, env) {
  const clear = adminCookie(FLOW, '', 0, 'Lax');
  let destination = ADMIN_PATH;
  try {
    const url = new URL(request.url), token = cookie(request, FLOW);
    if (!token || token.length > 4096 || url.search.length > 4096) throw new Error('Invalid callback');
    const flow = await verifyLocal(env, token, 'oauth');
    destination = flow.destination === 'comparison' ? '/' : flow.destination === 'safety' ? '/admin/suspensions' : ADMIN_PATH;
    if (typeof flow.state !== 'string' || !await equal(url.searchParams.get('state') ?? '', flow.state)) throw new Error('Invalid state');
    if (url.searchParams.has('error')) return redirect(destination+'?login=cancelled', [clear]);
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048 || typeof flow.verifier !== 'string' || typeof flow.nonce !== 'string') throw new Error('Invalid authorization');
    const response = await fetch('https://oauth2.googleapis.com/token', {method:'POST', redirect:'manual',
      headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal:AbortSignal.timeout(10000),
      body:new URLSearchParams({code, client_id:env.GOOGLE_CLIENT_ID, client_secret:env.GOOGLE_CLIENT_SECRET,
        redirect_uri:adminOrigin(env)+CALLBACK_PATH, grant_type:'authorization_code', code_verifier:flow.verifier})});
    // Never retain access/refresh tokens: only Google identity is needed here.
    const raw = await response.text();
    if (!response.ok || raw.length > 32768) throw new Error('Google sign-in unavailable');
    const data = JSON.parse(raw);
    if (typeof data.id_token !== 'string' || data.id_token.length > 16384) throw new Error('Missing Google identity');
    const principal = await verifyGoogleIdentity(data.id_token, env, flow.nonce);
    const session = await sign(env, {purpose:'session', email:principal.email}, principal.id, '8h');
    return redirect(destination, [clear, adminCookie(COMPARE_SESSION), adminCookie(SESSION, session, 28800)]);
  } catch {
    // OAuth codes, tokens and upstream error bodies must never appear in logs,
    // redirects or user-visible messages.
    return redirect(destination+'?login=failed', [clear]);
  }
}
export function endAdminSession() {
  const headers = new Headers(security);
  headers.append('Set-Cookie', adminCookie(SESSION));
  headers.append('Set-Cookie', adminCookie(COMPARE_SESSION));
  return Response.json({authenticated:false}, {headers});
}
