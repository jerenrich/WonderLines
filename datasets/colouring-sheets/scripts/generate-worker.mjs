// Uses the public app Worker. A persisted submission is recovered by GET only.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, stat, open, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {structuredComposition} from '../../../workers/coloring-sheets-api/src/composition.mjs';
import {imageRequest} from '../../../workers/coloring-sheets-api/src/image-provider.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '../..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const runID = option('--run', '20261005-sunburst-r01');
assert.match(runID, /^[a-z0-9][a-z0-9-]*$/);
const maxNew = Number(option('--max-new', '400'));
assert.ok(Number.isInteger(maxNew) && maxNew >= 0 && maxNew <= 400);
const concurrency = Number(option('--concurrency', '3'));
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 12);
const live = args.includes('--live');
const serviceURL = 'https://coloring-sheets-api.jordan-erenrich.workers.dev';
const model = 'gpt-image-2.5-sunburst';
const manifestPath = resolve(root, `manifests/${runID}.json`);
const planPath = resolve(root, `manifests/${runID}.jsonl`);
const summaryPath = resolve(root, `manifests/${runID}.summary.json`);
const privateDir = resolve(repo, '.build/colouring-dataset');
const now = () => new Date().toISOString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function atomic(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = path + '.tmp';
  await writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
const sourceFiles = [
  'ColoringSheets/Core/Generation.swift', 'ColoringSheets/Core/ColoringViewModel.swift',
  'workers/coloring-sheets-api/src/composition.mjs', 'workers/coloring-sheets-api/src/image-provider.mjs'
];
let plan;
let manifest;
if (await exists(manifestPath)) {
  manifest = await readJSON(manifestPath);
  plan = (await readFile(planPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(sha(await readFile(planPath)), manifest.plan_sha256, 'Generation plan has changed.');
  for (const [file, hash] of Object.entries(manifest.source_sha256)) {
    assert.equal(sha(await readFile(resolve(repo, file))), hash, `App/Worker source changed: ${file}`);
  }
} else {
  const catalogue = await readJSON(resolve(root, 'prompts/descriptions.json'));
  const guidance = await readJSON(resolve(root, 'prompts/generation-guidance.json'));
  const template = await readJSON(resolve(root, 'metadata/sample.template.json'));
  const created = now();
  const ageOrder = [3, 6, 9, 13, 4, 5, 7, 8, 10, 11, 12, 14, 15, 16, 17, 18];
  plan = [];
  for (const age of ageOrder) for (const entry of catalogue.descriptions) {
    const composition = 'side'; // iPhone app's first sheet, with image count set to one.
    const batchID = randomUUID();
    const composed = structuredComposition({description: entry.description, age, composition, batchID});
    assert.ok(composed);
    const band = guidance.age_bands.find(b => age >= b.minimum && age <= b.maximum);
    const native = imageRequest({OPENAI_API_KEY: 'local-prompt-validation-only'},
      {provider: 'openai', model}, composed.subject, {width: 1456, height: 1024});
    assert.equal(native.payload.prompt, guidance.standard_provider_prefix + composed.subject);
    const sample = structuredClone(template);
    Object.assign(sample, {
      sample_id: `${entry.id}-age${String(age).padStart(2, '0')}-${runID}-v01`,
      description_id: entry.id, age_target: age, age_band: band.id, composition,
      run_id: runID, created_at: created, provider: 'openai', model_id: model,
      description: entry.description, complexity_guidance: band.complexity,
      subject_prompt: composed.subject, effective_prompt: native.payload.prompt,
      negative_prompt: null,
      requested_parameters: {width: 1456, height: 1024, seed: null, quality: 'low', output_format: 'png', n: 1},
      worker: {service_url: serviceURL, account_index: Math.floor(plan.length / 100), generation_id: randomUUID(), batch_id: batchID,
        submitted_at: null, http_status: null, error_code: null, metrics: null,
        effective_prompt_source: 'Reconstructed from hashed local Worker source; API does not echo the provider prompt.'}
    });
    plan.push(sample);
  }
  assert.equal(plan.length, 400);
  assert.equal(new Set(plan.map(s => s.sample_id)).size, 400);
  const planText = plan.map(s => JSON.stringify(s)).join('\n') + '\n';
  await atomic(planPath, planText);
  const sourceHashes = {};
  for (const file of sourceFiles) sourceHashes[file] = sha(await readFile(resolve(repo, file)));
  manifest = {
    schema_version: '1.0', run_id: runID, created_at: created, service_url: serviceURL,
    requested_model: model, provider: 'openai', expected_upstream_model: model,
    age_order: ageOrder, planned_samples: plan.length, variants_per_description_age: 1,
    composition_policy: 'side: first iPhone app composition, one sheet per generation action',
    requested_size: {width: 1456, height: 1024}, quality: 'low', seed_policy: 'Provider-selected; unavailable seeds remain null',
    concurrency: 3, submission_policy: 'One POST per generation ID; GET recovery only after submission',
    account_policy: 'User-authorized: four anonymous dataset accounts, each assigned 100 planned samples; global Worker budget remains enforced',
    plan_sha256: sha(planText), source_sha256: sourceHashes,
    guidance_version: guidance.guidance_version,
    effective_prompt_provenance: 'Reconstructed from local Worker source and standard provider prefix; not echoed by API',
    model_routes_checked_at: null, selected_live_route: null
  };
  await atomic(manifestPath, manifest);
  await atomic(resolve(root, `manifests/${runID}.prompts.json`), catalogue);
  await atomic(resolve(root, `manifests/${runID}.guidance.json`), guidance);
}
async function records() {
  return Promise.all(plan.map(async sample => {
    const path = resolve(root, `metadata/samples/${sample.sample_id}.json`);
    return await exists(path) ? readJSON(path) : structuredClone(sample);
  }));
}
let latestAccess = null;
async function summarize(stopReason = null) {
  const samples = await records();
  const counts = {};
  let knownEstimate = 0, estimatedCount = 0, totalBytes = 0;
  for (const sample of samples) {
    counts[sample.status] = (counts[sample.status] ?? 0) + 1;
    const cost = sample.worker?.metrics?.estimatedTotalUsd;
    if (typeof cost === 'number') { knownEstimate += cost; estimatedCount++; }
    if (sample.image.raw_path && await exists(resolve(root, sample.image.raw_path))) totalBytes += (await stat(resolve(root, sample.image.raw_path))).size;
  }
  const summary = {run_id: runID, updated_at: now(), planned_samples: plan.length, counts,
    stop_reason: stopReason, latest_access: latestAccess,
    known_inference_estimate_usd: knownEstimate, samples_with_cost_estimates: estimatedCount,
    cost_note: 'Worker estimates, not billing receipts; excludes unreported failed-image, moderation, Worker and storage costs.',
    raw_image_bytes: totalBytes, review_status: 'Pending visual review; outputs are not yet curated.'};
  await atomic(summaryPath, summary);
  return summary;
}
if (!live) {
  console.log(JSON.stringify(await summarize('offline-plan-only')));
  process.exit(0);
}
await mkdir(privateDir, {recursive: true});
const lockPath = resolve(privateDir, runID + '.lock');
let lock;
try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
catch (error) { if (error.code === 'EEXIST') throw new Error('Another run may be active. Inspect the private lock before removing it.'); throw error; }
let token;
let selectedAccount = null;
async function selectAccount(index) {
  if (selectedAccount === index) return;
  const identityPath = resolve(privateDir, index === 0 ? 'identity.json' : `identity-${index}.json`);
  if (await exists(identityPath)) {
    const identity = await readJSON(identityPath);
    token = identity.accessToken;
    if (identity.expiresAt * 1000 <= Date.now() + 60000) {
      const response = await request('/v1/installations/renew', {body: {}});
      assert.equal(response.status, 200, 'Cannot renew saved dataset installation.');
      const renewed = await response.json();
      token = renewed.accessToken;
      await writeFile(identityPath, JSON.stringify(renewed), {mode: 0o600});
    }
  } else {
    token = undefined;
    const response = await request('/v1/installations', {body: {}});
    assert.equal(response.status, 201, 'Cannot register dataset installation.');
    const identity = await response.json();
    token = identity.accessToken;
    await writeFile(identityPath, JSON.stringify(identity), {mode: 0o600, flag: 'wx'});
  }
  selectedAccount = index;
}
async function request(path, {body, generationID, timeout = 240000} = {}) {
  const headers = {'User-Agent': 'WonderLines-Dataset/1.0', 'X-Coloring-API-Version': '1'};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (generationID) headers['Idempotency-Key'] = generationID;
  const response = await fetch(serviceURL + path, {method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal: AbortSignal.timeout(timeout)});
  return response;
}
let stopReason = null;
try {
  await selectAccount(0);
  async function access() {
    const response = await request('/v1/access', {timeout: 30000});
    assert.equal(response.status, 200, 'Cannot check saved installation allowance.');
    latestAccess = (await response.json()).access;
    return latestAccess;
  }
  const modelsResponse = await request('/v1/models', {timeout: 30000});
  assert.equal(modelsResponse.status, 200, 'Cannot check live model routing.');
  const route = (await modelsResponse.json()).models.find(m => m.id === model);
  assert.ok(route && route.provider === 'openai' && route.model === model, 'Sunburst route differs from the requested model.');
  manifest.model_routes_checked_at = now(); manifest.selected_live_route = route;
  manifest.concurrency = concurrency;
  manifest.moderation_batch_policy = 'Share one batch ID per identical original description and dataset account; each age keeps its own generation ID and composed subject.';
  await atomic(manifestPath, manifest);
  let attempts = 0;
  const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
  async function persist(sample) { await atomic(resolve(root, `metadata/samples/${sample.sample_id}.json`), sample); }
  if (args.includes('--retry-unreserved')) {
    // Only an explicit pre-reservation moderation outage can be reconsidered.
    // Preserve the generation ID (server idempotency) and archive the failure.
    const auditPath = resolve(root, `reviews/${runID}-unreserved-attempts.jsonl`);
    for (const sample of await records()) {
      if (sample.status !== 'failed' || sample.worker.http_status !== 503 || sample.worker.error_code !== 'moderation_unavailable') continue;
      await selectAccount(sample.worker.account_index);
      const job = await request(`/v1/generations/${sample.worker.generation_id}`, {timeout: 30000});
      if (job.status !== 404) {
        await handleResponse(sample, job);
        continue;
      }
      await mkdir(dirname(auditPath), {recursive: true});
      await writeFile(auditPath, JSON.stringify(sample) + '\n', {flag: 'a'});
      sample.status = 'planned'; sample.failure_reason = null;
      // Moderation failures are cached per batch for ten minutes. A fresh
      // action gets a fresh batch, just as a new Generate tap in the app does.
      sample.worker.batch_id = randomUUID(); sample.worker.submitted_at = null;
      sample.worker.http_status = null; sample.worker.error_code = null;
      await persist(sample);
    }
  }
  async function handleResponse(sample, response) {
    sample.worker.http_status = response.status;
    const accessHeader = response.headers.get('X-Access-Snapshot');
    if (accessHeader) latestAccess = JSON.parse(decodeURIComponent(accessHeader));
    if (response.status === 200 && response.headers.get('Content-Type')?.startsWith('image/png')) {
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG output.');
      const metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics') ?? '%7B%7D'));
      assert.equal(metrics.requestedModel, model);
      assert.equal(metrics.upstreamModel, model);
      assert.equal(response.headers.get('X-Generation-ID'), sample.worker.generation_id);
      const path = `images/raw/${runID}/age-${String(sample.age_target).padStart(2, '0')}/${sample.sample_id}.png`;
      await mkdir(dirname(resolve(root, path)), {recursive: true});
      await writeFile(resolve(root, path), bytes, {flag: 'wx'}).catch(async error => {
        if (error.code !== 'EEXIST' || sha(await readFile(resolve(root, path))) !== sha(bytes)) throw error;
      });
      Object.assign(sample, {status: 'generated', generated_at: now(), failure_reason: null, provider: metrics.provider, model_id: metrics.upstreamModel});
      sample.image = {raw_path: path, curated_path: null, sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), media_type: 'image/png'};
      sample.worker.metrics = metrics;
      sample.worker.error_code = null;
      sample.reported_parameters = {requested_model: metrics.requestedModel, upstream_model: metrics.upstreamModel, via_gateway: metrics.viaGateway};
      await persist(sample);
      console.log(JSON.stringify({sample_id: sample.sample_id, status: 'generated', width: sample.image.width, height: sample.image.height, estimated_usd: metrics.estimatedTotalUsd ?? null}));
      return true;
    }
    const data = await response.json();
    if (response.status === 202) return false;
    if (response.status === 404) {
      sample.status = 'uncertain'; sample.failure_reason = 'No saved job found after submission; no generation POST was repeated.';
      stopReason = 'uncertain-submission';
    } else {
      sample.status = 'failed'; sample.worker.error_code = data.error?.code ?? 'unexpected_response';
      sample.failure_reason = data.error?.message ?? 'Worker rejected the request.';
      if (sample.worker.error_code !== 'description_not_suitable') stopReason = sample.worker.error_code;
    }
    await persist(sample);
    console.log(JSON.stringify({sample_id: sample.sample_id, status: sample.status, http_status: response.status, error_code: sample.worker.error_code}));
    return true;
  }
  async function recover(sample) {
    for (let poll = 0; poll < 40; poll++) {
      if (poll) await sleep(5000);
      try {
        const response = await request(`/v1/generations/${sample.worker.generation_id}`, {timeout: 30000});
        if (await handleResponse(sample, response)) return;
      } catch { /* Recovery GETs do not submit another image. */ }
    }
    sample.status = 'uncertain'; sample.failure_reason = 'Recovery polling did not produce a terminal result; retain the original generation ID.';
    await persist(sample); stopReason = 'recovery-incomplete';
  }
  // Finish saved submissions before making any new paid request.
  for (const sample of await records()) {
    if (['submitted', 'uncertain'].includes(sample.status)) {
      await selectAccount(sample.worker.account_index);
      await recover(sample);
    }
    if (stopReason) break;
  }
  while (!stopReason) {
    const pending = (await records()).filter(s => s.status === 'planned');
    if (!pending.length) { stopReason = 'plan-finished'; break; }
    if (attempts >= maxNew) { stopReason = 'requested-attempt-limit'; break; }
    await selectAccount(pending[0].worker.account_index);
    const current = await access();
    const allowance = current.freeGenerationsRemaining + current.generationCredits;
    if (allowance <= 0) { stopReason = 'daily-allowance-exhausted'; break; }
    const sameAccount = pending.filter(s => s.worker.account_index === selectedAccount);
    const wave = sameAccount.slice(0, Math.min(concurrency, maxNew - attempts, allowance));
    await Promise.all(wave.map(async sample => {
      const canonical = plan.find(s => s.description_id === sample.description_id && s.worker.account_index === sample.worker.account_index);
      sample.worker.batch_id = canonical.worker.batch_id;
      // Persist the one-time claim BEFORE sending; a restart only recovers by GET.
      sample.status = 'submitted'; sample.worker.submitted_at = now();
      await persist(sample); attempts++;
      const body = {description: sample.description, age: sample.age_target, composition: sample.composition,
        batchID: sample.worker.batch_id, model, width: 1456, height: 1024};
      try {
        const response = await request('/v1/generations', {body, generationID: sample.worker.generation_id});
        if (!await handleResponse(sample, response)) await recover(sample);
      } catch {
        sample.status = 'uncertain'; sample.failure_reason = 'Transport or output validation failed; checking the original job without repeating POST.';
        await persist(sample); await recover(sample);
      }
    }));
    await summarize(stopReason);
  }
  await access();
  console.log(JSON.stringify(await summarize(stopReason)));
} catch (error) {
  await summarize('runner-error');
  console.error(error instanceof assert.AssertionError ? error.message : 'Runner failed; inspect persisted records before resuming.');
  process.exitCode = 1;
} finally {
  await lock.close(); await unlink(lockPath);
}
