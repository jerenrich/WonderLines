import {adminConfigured, comparisonPrincipal, endComparisonSession} from './admin-auth.mjs';
import {catalog,unavailableModels} from './catalog.mjs';
import {ComparisonLibrary} from './library.mjs';
export {ComparisonLibrary};
export {ModelCatalogueAdmin} from './model-admin-store.mjs';
import {handleModelAdmin} from './model-admin-api.mjs';
import {isUUID} from '../../coloring-sheets-api/src/composition.mjs';
import {readBoundedBody, RequestBodyTooLarge} from '../../shared/request-body.mjs';
import {observeStorage, storageFailure} from '../../shared/operational-events.mjs';

const security = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY'};
const json = (value, status = 200, headers = {}) => Response.json(value, {status, headers: {...security, ...headers}});
const fail = (message, status, code = 'request_failed') => json({error: {message, code}}, status);
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
  if (path.startsWith('/api/admin/')) return handleModelAdmin(request, env);
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (!isUUID(env.LAB_ACCOUNT_ID)) return fail('The comparison service needs configuration.', 503);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return fail('Method not allowed.', 405);
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return fail('Please use this website to make the request.', 403);
  if (path === '/api/session') {
    if (request.method === 'GET') {
      const identity = await comparisonPrincipal(request, env);
      return json({configured:adminConfigured(env), authenticated:!!identity, ...(identity?{email:identity.email}:{})});
    }
    if (request.method === 'DELETE') return json({authenticated:false}, 200, {'Set-Cookie':endComparisonSession()});
    return fail('Method not allowed.',405);
  }
  const identity = await comparisonPrincipal(request, env);
  if (!identity) return fail('Sign in with your authorized Google account.', 401, 'unauthorized');
  const principal = {id:identity.id, accountId:env.LAB_ACCOUNT_ID, method:'google'};
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
    const image = await observeStorage('image_read', job.id, () => env.GENERATIONS.get(expected));
    if (!image) { storageFailure('image_missing', job.id); return fail('The saved image is unavailable.', 410); }
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
