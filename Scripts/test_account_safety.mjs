import assert from 'node:assert/strict';
import {Account} from '../workers/coloring-sheets-api/src/index.mjs';
import {AccountSafety, DAY, cleanSafetyDirectory} from '../workers/coloring-sheets-api/src/account-safety.mjs';
import {ComparisonImageRunner} from '../workers/coloring-sheets-api/src/comparison-image-runner.mjs';
import {service, Storage, actor, invoke} from './fixtures/safety-service.mjs';

const now = Date.now, fetchBefore = globalThis.fetch, infoBefore = console.info, errorBefore = console.error;
let clock = now(), calls = 0; const logs = [];
Date.now = () => clock; console.info = value => logs.push(value); console.error = value => logs.push(value);
globalThis.fetch = async () => {calls++; return Response.json({data: [{b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='}]});};
try {
  const test = service(), identity = await test.register(); let account = test.env.ACCOUNTS.objects.get(identity.accountId);
  const completed = crypto.randomUUID(); assert.equal((await test.generate(identity, {id: completed})).status, 200);
  const queued = crypto.randomUUID(); assert.equal((await test.generate(identity, {id: queued, queued: true})).status, 202);
  test.state.verdict = 'reject';
  for (let i = 0; i < 19; i++) {
    const batchID = crypto.randomUUID();
    assert.deepEqual((await Promise.all(Array.from({length: 3}, () => test.generate(identity, {batchID})))).map(r => r.status), [400,400,400]);
    assert.equal((await account.safety.read()).rejectionCount, i + 1, 'One strike per three-sheet batch.');
  }
  const before = await account.access(), providerCalls = calls, checks = test.state.checks;
  const twentieth = crypto.randomUUID();
  assert.deepEqual((await Promise.all(Array.from({length: 3}, () => test.generate(identity, {batchID: twentieth})))).map(r => r.status), [403,403,403]);
  let status = await account.safety.read(); assert.equal(status.rejectionCount, 20); assert.equal(status.suspension.until, clock + DAY);
  const until = status.suspension.until;
  assert.equal(calls, providerCalls); assert.equal(test.state.checks, checks + 1);
  assert.deepEqual(await account.access(), before, 'Suspension consumes no allowance.');
  assert.equal((await test.generate(identity)).status, 403); assert.equal(test.state.checks, checks + 1, 'Block before calling moderation.');
  assert.equal((await account.safety.read()).suspension.until, until, 'Blocked attempts never extend suspension.');
  const renewed = await (await test.request(identity, '/v1/installations/renew', {method: 'POST', body: '{}'})).json();
  assert.equal(renewed.accountId, identity.accountId); assert.equal((await test.generate(renewed)).status, 403);
  assert.equal((await test.request(identity, '/v1/generations/' + completed)).status, 200, 'Saved images remain recoverable.');
  assert.equal((await test.request(identity, '/v1/generations/' + completed + '/report', {method: 'POST', body: JSON.stringify({reason: 'other'})})).status, 201);
  assert.equal((await account.safety.read()).rejectionCount, 20, 'A report never counts as a strike.');
  const directory = test.env.BUDGET.objects.get('daily-generation-budget');
  assert.equal((await directory.state.storage.get('suspension:' + identity.accountId)).version, status.version);
  account = new Account(account.state, test.env); test.env.ACCOUNTS.objects.set(identity.accountId, account);
  assert.equal((await test.generate(identity)).status, 403, 'Suspension survives eviction/restart.');
  account.state.storage.alarm = null; await account.alarm(); assert.equal(calls, providerCalls, 'Queued jobs cannot start during suspension.');
  assert.equal((await test.request(identity, '/v1/generations/' + queued)).status, 403);
  clock = until;
  test.state.verdict = 'allow'; assert.equal((await test.generate(identity)).status, 200, 'Automatic suspension expires after 24 hours.');
  assert.equal((await account.safety.read()).rejectionCount, 0);
  assert.equal((await test.change(account, 'suspend', {durationHours: null})).status, 200);
  clock += 2 * DAY; assert.equal((await test.generate(identity)).status, 403, 'Indefinite operator suspension does not expire.');
  assert.equal((await test.change(account, 'reinstate')).status, 200); assert.equal((await test.generate(identity)).status, 200);
  assert.equal((await invoke(account, '/admin/safety', {actor: {...actor, email: 'other@example.com'}})).status, 403);
  assert.equal((await test.request(identity, '/admin/safety/change', {method: 'POST', body: '{}'})).status, 404, 'Public credentials cannot reach internal administration.');

  // Queued fal submissions use the same no-provider-IO gate.
  const falID = crypto.randomUUID();
  await account.state.storage.put('job:' + falID, {id: falID, state: 'processing', createdAt: clock, fal: {stage: 'queued', request: {provider: 'fal', model: 'fal-ai/lora', payload: {}}}});
  await account.state.storage.put('fal:' + falID, falID);
  await test.change(account, 'suspend'); const beforeFal = calls;
  await account.advanceFal(falID); assert.equal(calls, beforeFal); assert.equal((await account.state.storage.get('job:' + falID)).errorCode, 'account_suspended');
  await test.change(account, 'reinstate');

  // Legacy subjects count once even when moderation is retried with the same ID.
  const legacy = service(), oldIdentity = await legacy.register(), oldAccount = legacy.env.ACCOUNTS.objects.get(oldIdentity.accountId);
  legacy.state.verdict = 'reject'; const legacyID = crypto.randomUUID();
  for (let i = 0; i < 3; i++) assert.equal((await legacy.generate(oldIdentity, {id: legacyID, legacy: true})).status, 400);
  assert.equal((await oldAccount.safety.read()).rejectionCount, 1);
  clock += 11 * 60000;
  assert.equal((await invoke(oldAccount, '/moderate-batch', {batchID: legacyID, description: 'A different synthetic example', legacy: true})).status, 409,
    'Reusing a rejected ID with different content cannot evade counting after the decision cache expires.');
  legacy.state.verdict = 'uncertain'; assert.equal((await legacy.generate(oldIdentity, {legacy: true})).status, 400);
  legacy.state.verdict = 'outage'; assert.equal((await legacy.generate(oldIdentity, {legacy: true})).status, 503);
  assert.equal((await oldAccount.safety.read()).rejectionCount, 1, 'Uncertain answers and service failures do not add strikes.');
  clock += DAY; legacy.state.verdict = 'reject'; await legacy.generate(oldIdentity, {legacy: true});
  assert.equal((await oldAccount.safety.read()).rejectionCount, 1, 'The window rolls; it is not a calendar-day counter.');

  // A failed strike commit after the moderation cache write is retried safely.
  const retry = service(), retryIdentity = await retry.register(), retryAccount = retry.env.ACCOUNTS.objects.get(retryIdentity.accountId);
  retry.state.verdict = 'reject'; retryAccount.state.storage.failCommit = true;
  const retryBatch = crypto.randomUUID(); await assert.rejects(retry.generate(retryIdentity, {batchID: retryBatch}), /Synthetic storage commit/);
  assert.equal((await retry.generate(retryIdentity, {batchID: retryBatch})).status, 400);
  assert.equal((await retryAccount.safety.read()).rejectionCount, 1);
  assert.equal(retry.state.checks, 1, 'The cached decision retries persistence, not moderation.');

  // Atomic counter updates, explicit reinstatement, receipts, and stale tabs.
  const storage = new Storage(), safety = new AccountSafety(storage), rejection = {code: 'description_not_suitable', status: 400, reasonCodes: ['violence']};
  await Promise.all(Array.from({length: 25}, () => safety.reject(crypto.randomUUID(), rejection, 0)));
  assert.equal((await safety.read()).rejectionCount, 20); assert.equal((await safety.read()).history.length, 1);
  const operation = {actor, action: 'reinstate', reason: 'Synthetic review', requestId: crypto.randomUUID(), expectedVersion: (await safety.read()).version};
  assert.equal((await safety.change(operation)).status, 200); assert.equal((await safety.change(operation)).status, 200);
  assert.equal((await safety.read()).history.length, 2); assert.equal((await safety.read()).rejectionCount, 0);
  assert.equal((await safety.change({...operation, reason: 'Changed payload'})).status, 409);
  assert.equal((await safety.change({...operation, requestId: crypto.randomUUID()})).status, 409);
  await safety.reject(crypto.randomUUID(), rejection, 0); assert.equal((await safety.read()).rejectionCount, 0, 'An outcome started before reinstatement cannot undo it.');
  const currentEpoch = (await safety.read()).epoch; await safety.reject(crypto.randomUUID(), rejection, currentEpoch);
  assert.equal((await safety.read()).rejectionCount, 1);
  clock += DAY; storage.alarm = null; await safety.maintain(async () => {});
  assert.deepEqual((await storage.get('account-safety')).rejections, [], 'Expired strike metadata is physically removed.');

  // A lost directory write retries after restart; the account stays blocked.
  const delayed = service(), delayedIdentity = await delayed.register(), delayedAccount = delayed.env.ACCOUNTS.objects.get(delayedIdentity.accountId);
  const realBudget = delayed.env.BUDGET; delayed.env.BUDGET = {get() {throw Error('Synthetic directory outage');}, idFromName: id => id};
  assert.equal((await delayed.change(delayedAccount, 'suspend')).status, 200);
  assert.equal((await delayed.generate(delayedIdentity)).status, 403);
  assert.ok((await delayedAccount.state.storage.get('account-safety')).pendingDirectory);
  delayed.env.BUDGET = realBudget; delayedAccount.state.storage.alarm = null; await delayedAccount.alarm();
  assert.equal((await delayedAccount.state.storage.get('account-safety')).pendingDirectory, undefined);
  const delayedDirectory = realBudget.objects.get('daily-generation-budget');
  assert.ok(await delayedDirectory.state.storage.get('suspension:' + delayedIdentity.accountId));
  const live = await delayedAccount.safety.read();
  assert.equal((await delayed.change(delayedAccount, 'reinstate')).status, 200);
  await invoke(delayedDirectory, '/safety-index', {accountId: delayedIdentity.accountId, version: live.version, suspension: live.suspension, updatedAt: clock});
  assert.equal((await delayedDirectory.state.storage.get('suspension:' + delayedIdentity.accountId)).suspension, null, 'A delayed index delivery cannot undo reinstatement.');
  await delayed.change(delayedAccount, 'suspend');
  assert.equal((await delayed.request(delayedIdentity, '/v1/account', {method: 'DELETE'})).status, 200, 'Suspended accounts can delete all their data.');
  assert.equal(await delayedDirectory.state.storage.get('suspension:' + delayedIdentity.accountId), undefined);
  assert.equal(await delayedAccount.state.storage.get('account-safety'), undefined);

  // Admission must recheck after the global-budget network await.
  const racing = service(), racingIdentity = await racing.register(), racingAccount = racing.env.ACCOUNTS.objects.get(racingIdentity.accountId), budget = racing.env.BUDGET;
  racing.env.BUDGET = {idFromName: id => id, get: id => ({fetch: async (url, options) => {
    if (new URL(url).pathname === '/reserve') await racing.change(racingAccount, 'suspend');
    return budget.get(id).fetch(url, options);
  }})};
  const beforeRace = await racingAccount.access(); assert.equal((await racing.generate(racingIdentity)).status, 403);
  assert.deepEqual(await racingAccount.access(), beforeRace, 'An operator change during reservation cannot spend account allowance.');

  // Delegated comparison runners also check the account before provider IO.
  const runnerState = new Storage(), runnerAccount = crypto.randomUUID(), runnerID = crypto.randomUUID(); let completedResult;
  const runner = new ComparisonImageRunner({storage: runnerState}, {COMPARISON_ACCOUNT_ID: runnerAccount, OPENAI_API_KEY: 'synthetic', ACCOUNTS: {idFromName: id => id, get: () => ({fetch: async (url, options) => {
    if (new URL(url).pathname === '/generation-gate') return Response.json({error: {code: 'account_suspended', message: 'Generation suspended.'}}, {status: 403});
    completedResult = JSON.parse(options.body).result; return Response.json({});
  }})}});
  await runner.fetch(new Request('https://runner/start', {method: 'POST', body: JSON.stringify({id: runnerID, accountId: runnerAccount, fingerprint: 'test', createdAt: clock, subject: 'Synthetic example', route: {provider: 'openai', model: 'gpt-image-2.5-flare'}, size: {width: 1456, height: 1024}})}));
  const beforeRunner = calls; await runner.alarm(); assert.equal(calls, beforeRunner); assert.equal(completedResult.errorCode, 'account_suspended');
  // Deletion while a runner is queued must discard its prompt, not retry forever.
  const deletedRunnerState = new Storage(), deletedRunner = new ComparisonImageRunner({storage: deletedRunnerState}, {
    COMPARISON_ACCOUNT_ID: runnerAccount, OPENAI_API_KEY: 'synthetic', GENERATIONS: {delete: async () => {}},
    ACCOUNTS: {idFromName: id => id, get: () => ({fetch: async url => Response.json({error: {code: 'account_deleted'}}, {status: new URL(url).pathname === '/generation-gate' ? 410 : 404})})}});
  await deletedRunner.fetch(new Request('https://runner/start', {method: 'POST', body: JSON.stringify({id: crypto.randomUUID(), accountId: runnerAccount, fingerprint: 'test', createdAt: clock,
    subject: 'Synthetic example', route: {provider: 'openai', model: 'gpt-image-2.5-flare'}, size: {width: 1456, height: 1024}})}));
  await deletedRunner.alarm(); assert.equal((await deletedRunnerState.get('task')).stage, 'done');
  assert.equal((await deletedRunnerState.get('task')).subject, undefined); assert.equal(calls, beforeRunner);
  clock += 2 * DAY; await cleanSafetyDirectory(directory.state.storage);
  assert.equal(await directory.state.storage.get('suspension:' + identity.accountId), undefined);
  assert.ok(!JSON.stringify(logs).includes('Synthetic example'), 'Safety operations never log descriptions.');
} finally {Date.now = now; globalThis.fetch = fetchBefore; console.info = infoBefore; console.error = errorBefore;}
console.log('PASS: rolling strikes, batch/retry deduplication, outage exclusion, expiry, operator receipts, concurrency, renewals, queue/runner gates, restart/outbox recovery, deletion and retention; no network.');
