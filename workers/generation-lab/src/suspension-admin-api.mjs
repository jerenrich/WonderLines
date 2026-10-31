import {isUUID} from '../../coloring-sheets-api/src/composition.mjs';
import {readBoundedBody} from '../../shared/request-body.mjs';

// The shared admin router verifies Google identity, canonical origin and CSRF
// before entering this handler. No access token or browser-supplied actor passes.
export async function handleSuspensionAdmin(request, env, principal) {
  const url = new URL(request.url), path = url.pathname;
  if (!env.ACCOUNTS || !env.BUDGET) return Response.json({error: {code: 'storage_not_configured', message: 'Account administration is unavailable.'}}, {status: 503});
  if (path === '/api/admin/suspensions' && request.method === 'GET') {
    const directory = env.BUDGET.get(env.BUDGET.idFromName('daily-generation-budget'));
    return directory.fetch('https://budget/suspensions', {method: 'POST', body: JSON.stringify(url.searchParams.has('cursor') ? {cursor: url.searchParams.get('cursor')} : {})});
  }
  const match = /^\/api\/admin\/accounts\/([a-f0-9-]{36})(\/suspension)?$/.exec(path);
  if (!match || !isUUID(match[1]) || !(request.method === 'GET' && !match[2] || request.method === 'POST' && match[2])) return Response.json({error: {code: 'not_found', message: 'Not found.'}}, {status: 404});
  let input = {};
  if (request.method === 'POST') {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new TypeError('JSON required');
    input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readBoundedBody(request, 4096)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Object required');
    // Allow only the action fields. In particular, never forward actor or state.
    input = Object.fromEntries(['action', 'durationHours', 'reason', 'requestId', 'expectedVersion'].map(name => [name, input[name]]));
  }
  const account = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(match[1]));
  return account.fetch('https://account/admin/safety' + (request.method === 'POST' ? '/change' : ''), {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...input, actor: {id: principal.id, email: principal.email}})
  });
}
