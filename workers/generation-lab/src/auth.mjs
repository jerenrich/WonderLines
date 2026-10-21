// Replace this boundary with Google identity next; generation routes use a principal.
const COOKIE = '__Host-wonderlines_compare';
const DAYS_30 = 2592000;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
async function mac(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}
export async function equal(a, b) {
  const hash = text => crypto.subtle.digest('SHA-256', encoder.encode(text));
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let mismatch = 0; for (let i = 0; i < x.length; i++) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}
export function sessionCookie(value = '', maxAge = 0) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export async function createSession(env, remember) {
  const duration = remember ? DAYS_30 : 43200;
  const payload = `${Math.floor(Date.now() / 1000) + duration}.${crypto.randomUUID()}`;
  const value = payload + '.' + await mac(env.LAB_ACCESS_KEY, payload);
  return remember ? sessionCookie(value, duration) : `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
export async function getPrincipal(request, env) {
  if (!env.LAB_ACCESS_KEY) return null;
  const value = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!value || !/^\d+\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(value)) return null;
  const [expires, nonce, signature] = value.split('.');
  const now = Math.floor(Date.now() / 1000);
  if (Number(expires) <= now || Number(expires) > now + DAYS_30 || !await equal(signature, await mac(env.LAB_ACCESS_KEY, expires + '.' + nonce))) return null;
  return {id: 'shared-lab', accountId: env.LAB_ACCOUNT_ID, method: 'shared-key'};
}
