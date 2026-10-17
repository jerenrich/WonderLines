import assert from 'node:assert/strict';
import worker, {POLICY, runRetention} from '../src/index.mjs';
const now = Date.parse('2026-10-17T12:00:00Z');
const cutoff = '2026-10-10T12:00:00.000Z';
const token = 'synthetic-retention-token-never-log';
const env = {RETENTION_MODE: 'enforce', CLOUDFLARE_LOG_RETENTION_TOKEN: token};
const rows = [
  {id: 'old', created_at: '2026-10-10T11:59:59.999Z'},
  {id: 'edge', created_at: cutoff},
  {id: 'new', created_at: '2026-10-17T11:00:00Z'},
];
function cloudflare({ignoreFilters = false, malformedCount = false, failDelete = false, deleteDoesNothing = false, limit = Infinity} = {}) {
  const saved = structuredClone(rows), calls = [];
  const fetcher = async (url, init) => {
    const u = new URL(url); calls.push({url, method: init.method});
    assert.equal(u.origin, 'https://api.cloudflare.com');
    assert.equal(u.pathname, `/client/v4/accounts/${POLICY.accountId}/ai-gateway/gateways/coloring-sheets/logs`);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    assert.equal(u.searchParams.get('filters.key'), 'created_at');
    assert.equal(u.searchParams.get('filters.operator'), 'lt');
    const date = Date.parse(u.searchParams.get('filters.value'));
    const matches = saved.filter(row => ignoreFilters || Date.parse(row.created_at) < date);
    if (init.method === 'DELETE') {
      assert.equal(u.searchParams.get('filters.value'), cutoff);
      assert.equal(Number(u.searchParams.get('limit')), 10000);
      if (failDelete) return Response.json({success:false, errors:[{message:token}]}, {status:403});
      if (!deleteDoesNothing) for (const row of matches.slice(0, limit)) saved.splice(saved.indexOf(row), 1);
      return Response.json({success:true});
    }
    return Response.json({success:true,result:matches.slice(0,1),result_info:{total_count:malformedCount?'1':matches.length}});
  };
  return {saved,calls,fetcher};
}
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('PASS: '+name); }
await test('only logs strictly older than seven days are removed; cutoff and newer logs survive', async () => {
  const cf = cloudflare(); const result = await runRetention(env,{now,fetcher:cf.fetcher});
  assert.equal(result.removed,1); assert.equal(result.expiredAfter,0);
  assert.deepEqual(cf.saved.map(x=>x.id),['edge','new']);
  assert.ok(!JSON.stringify(result).includes(token));
});
await test('dry run reads counts without deleting', async () => {
  const cf = cloudflare(); const result = await runRetention({...env,RETENTION_MODE:'dry-run'},{now,fetcher:cf.fetcher});
  assert.equal(result.expiredBefore,1);assert.equal(result.removed,0);assert.equal(cf.saved.length,3);
  assert.ok(cf.calls.every(x=>x.method==='GET'));
});
await test('missing credential, invalid mode and invalid clock make no API requests', async () => {
  for(const [e,time] of [[{...env,CLOUDFLARE_LOG_RETENTION_TOKEN:''},now],[{...env,RETENTION_MODE:'yes'},now],[env,NaN]]) {
    const cf=cloudflare();await assert.rejects(runRetention(e,{now:time,fetcher:cf.fetcher}));assert.equal(cf.calls.length,0);
  }
});
await test('ignored date filter fails before any deletion', async () => {
  const cf=cloudflare({ignoreFilters:true});await assert.rejects(runRetention(env,{now,fetcher:cf.fetcher}),/unsafe_log_selection/);
  assert.ok(cf.calls.every(x=>x.method==='GET'));assert.equal(cf.saved.length,3);
});
await test('a recent result is rejected even after the filter probe passes', async () => {
  const cf=cloudflare();let reads=0;
  const fetcher=async (url,init)=>{
    reads++;
    if(reads===2) return Response.json({success:true,result:[rows[2]],result_info:{total_count:1}});
    return cf.fetcher(url,init);
  };
  await assert.rejects(runRetention(env,{now,fetcher}),/unsafe_log_selection/);
  assert.equal(cf.saved.length,3);assert.ok(cf.calls.every(x=>x.method==='GET'));
});
await test('malformed metadata fails before any deletion', async () => {
  const cf=cloudflare({malformedCount:true});await assert.rejects(runRetention(env,{now,fetcher:cf.fetcher}),/invalid_log_summary/);
  assert.ok(cf.calls.every(x=>x.method==='GET'));
});
await test('no expired logs is an idempotent no-op', async () => {
  const cf=cloudflare();cf.saved.shift();const result=await runRetention(env,{now,fetcher:cf.fetcher});
  assert.equal(result.removed,0);assert.ok(cf.calls.every(x=>x.method==='GET'));
});
await test('API permission failure is reported without leaking response bodies', async () => {
  const cf=cloudflare({failDelete:true});await assert.rejects(runRetention(env,{now,fetcher:cf.fetcher}),/retention_credential_rejected/);
  assert.equal(cf.saved.length,3);
});
await test('a success response without verified deletion is not reported as success', async () => {
  const cf=cloudflare({deleteDoesNothing:true});await assert.rejects(runRetention(env,{now,fetcher:cf.fetcher}),/retention_progress_unverified/);
});
await test('partial batch deletion records remaining work for the next hourly run', async () => {
  const cf=cloudflare({limit:1});cf.saved.push({id:'another-old',created_at:'2026-10-01T00:00:00Z'});
  const result=await runRetention(env,{now,fetcher:cf.fetcher});assert.equal(result.removed,1);assert.equal(result.expiredAfter,1);
});
await test('public requests cannot trigger cleanup', async () => {
  assert.equal((await worker.fetch(new Request('https://test/run',{method:'POST'}))).status,404);
});
await test('scheduled failures log only a fixed error code', async () => {
  const oldError=console.error;const output=[];console.error=x=>output.push(x);
  try {await assert.rejects(worker.scheduled({},{}),/invalid_retention_mode/);}
  finally {console.error=oldError;}
  assert.equal(output.length,1);assert.ok(!output[0].includes(token));assert.equal(JSON.parse(output[0]).code,'invalid_retention_mode');
});
console.log(`PASS: ${checks} log-retention checks; synthetic data only, no network.`);
