import {getPrincipal, createSession, sessionCookie, equal} from './auth.mjs';
import {catalog,unavailableModels} from './catalog.mjs';
import {ComparisonLibrary} from './library.mjs';
export {ComparisonLibrary};
import {isUUID} from '../../coloring-sheets-api/src/composition.mjs';
import {readBoundedBody, RequestBodyTooLarge} from '../../shared/request-body.mjs';

const security = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY'};
const json = (value, status = 200, headers = {}) => Response.json(value, {status, headers: {...security, ...headers}});
const fail = (message, status, code = 'request_failed') => json({error: {message, code}}, status);
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join('');
async function body(request, max = 4096) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new TypeError('JSON required');
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readBoundedBody(request, max)));
}
function account(env, principal) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(principal.accountId));
}
async function call(stub, path, input = {}) {
  const response = await stub.fetch('https://account' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)});
  return {status: response.status, value: await response.json()};
}
async function ensureAccount(stub, principal) {
  let result = await call(stub, '/access');
  if (result.status === 404) {
    const initialized = await call(stub, '/initialize', {accountId: principal.accountId});
    if (![201, 409].includes(initialized.status)) return false;
    result = await call(stub, '/access');
  }
  return result.status === 200;
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!env.LAB_ACCESS_KEY || !isUUID(env.LAB_ACCOUNT_ID)) return fail('The comparison service needs configuration.', 503);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return fail('Method not allowed.', 405);
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return fail('Please use this website to make the request.', 403);
  if (path === '/api/session') {
    if (request.method === 'GET') return json({authenticated: !!await getPrincipal(request, env)});
    if (request.method === 'DELETE') return json({authenticated: false}, 200, {'Set-Cookie': sessionCookie()});
    const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!env.LOGIN_LIMITER || !(await env.LOGIN_LIMITER.limit({key: await hash(address)})).success) return fail('Too many attempts. Try again in a minute.', 429);
    const input = await body(request);
    if (typeof input?.key !== 'string' || input.key.length > 256 || !await equal(input.key, env.LAB_ACCESS_KEY)) return fail('That access key isn’t correct.', 401);
    return json({authenticated: true}, 200, {'Set-Cookie': await createSession(env, input.remember === true)});
  }
  const principal = await getPrincipal(request, env);
  if (!principal) return fail('Enter your access key to continue.', 401, 'unauthorized');
  const stub = account(env, principal);
  if (path === '/api/config' && request.method === 'GET') {
    if (!await ensureAccount(stub, principal)) return fail('Could not open the comparison account.', 503);
    const {value} = await call(stub, '/access');
    return json({models: catalog(env), unavailableModels, access: value.access, auth: principal.method, maxImages: 80});
  }
  const library = (operation, input) => {
    const store = env.LIBRARY.get(env.LIBRARY.idFromName(principal.accountId));
    return store.fetch('https://library' + operation, {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(input ?? {})})
      .then(response => new Response(response.body, {status:response.status,headers:{...security,'Content-Type':'application/json'}}));
  };
  if (path === '/api/library') {
    if (request.method === 'GET') return library('/list');
    if (request.method === 'POST') return library('/save', await body(request, 16384));
    return fail('Method not allowed.',405);
  }
  const gridMatch = /^\/api\/library\/([a-f0-9-]{36})$/.exec(path);
  if (gridMatch && isUUID(gridMatch[1]) && request.method === 'GET') return library('/get',{id:gridMatch[1]});
  if (path === '/api/generations' && request.method === 'POST') return library('/start', await body(request));
  const match = /^\/api\/(generations|images)\/([a-f0-9-]{36})$/.exec(path);
  if (match && isUUID(match[2]) && request.method === 'GET') {
    if (match[1] === 'generations') return library('/job',{id:match[2]});
    const lookup = await library('/lookup',{id:match[2]});
    if (!lookup.ok) return lookup;
    const found = await call(stub, '/job', {generationId: match[2]});
    if (found.status !== 200) return fail('This image could not be found.', 404);
    const {job} = found.value;
    if (job.state !== 'completed') return fail('This image isn’t ready yet.', 409);
    // Never accept client object keys or expose provider payloads from the job.
    const expected = principal.accountId + '/' + job.id + '.png';
    if (job.objectKey !== expected) return fail('This image could not be found.', 404);
    const image = await env.GENERATIONS.get(expected);
    if (!image) return fail('The saved image is unavailable.', 410);
    return new Response(image.body, {headers: {...security, 'Content-Type': 'image/png', 'Content-Disposition': `inline; filename="wonderlines-${job.id}.png"`}});
  }
  return fail('Not found.', 404);
}
export default {async fetch(request, env) {
  try { return await handle(request, env); }
  catch (error) {
    if (error instanceof RequestBodyTooLarge) return fail('The request is too large.', 413);
    if (error instanceof SyntaxError || error instanceof TypeError) return fail('The request could not be read.', 400);
    return fail('The comparison service is temporarily unavailable.', 503);
  }
}};
