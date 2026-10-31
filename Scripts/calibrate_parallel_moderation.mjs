// Explicit live text-only scoring, resumable without repeating completed calls.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {moderationInput, moderationScores, moderationThresholds, MODERATION_MODELS, directTypeSafeScores} from '../workers/coloring-sheets-api/src/moderation.mjs';
import {DIRECT_JEV_MODEL, directJevThresholds} from '../workers/coloring-sheets-api/src/moderation-profiles.mjs';
import {readBoundedBody} from '../workers/shared/request-body.mjs';
import {fitThresholds, summarize, evaluatePair} from './lib/moderation-calibration.mjs';
const root = new URL('../', import.meta.url);
const arg = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const load = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const sources = ['moderation-cases', 'moderation-validation-cases', 'moderation-clef-calibration-cases', 'moderation-permissive-cases', 'moderation-car-regressions', 'moderation-parallel-holdout'];
const deduplicated = new Map();
for (const name of sources) for (const row of await load('Scripts/fixtures/' + name + '.json')) {
  const previous = deduplicated.get(row.description);
  const split = name === 'moderation-parallel-holdout' ? 'holdout' : row.split === 'holdout' ? 'validation' : 'calibration';
  const rank = {calibration: 0, validation: 1, holdout: 2};
  if (previous && previous.expected !== row.allowed) throw Error('Conflicting fixture labels');
  // A description appearing in validation must never be used for fitting.
  deduplicated.set(row.description, {name: row.name, description: row.description, expected: row.allowed,
    split: previous && rank[previous.split] > rank[split] ? previous.split : split});
}
const corpus = [...deduplicated.values()];
const fixtureHash = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const rubricHash = createHash('sha256').update(JSON.stringify(moderationInput('').questions)).digest('hex');
const output = arg('output');
if (!output) throw Error('Use --output=path [--live --provider=clef|jev|both] [--report=path] [--write-profiles]');
let document;
try { document = JSON.parse(await readFile(output, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (document && (document.fixtureHash !== fixtureHash || document.rubricHash !== rubricHash || document.jevModel !== DIRECT_JEV_MODEL)) throw Error('Existing run uses different fixtures/model; choose a new output');
document ??= {createdAt: new Date().toISOString(), fixtureHash, rubricHash, baselineProfiles:{clef:moderationThresholds(MODERATION_MODELS.clef),jev:directJevThresholds}, jevModel: DIRECT_JEV_MODEL,
  method: 'One text-only request per service per synthetic prompt. No automatic retries. Calibration/validation/test labels fixed before direct Jev scoring. Existing Clef observations reused with an explicitly recorded split refinement; final test labels never used to fit thresholds. Direct Cloudflare REST for calibration; production Clef uses its AI binding and Gateway.', results: corpus};
if (process.argv.includes('--live')) {
  const provider = arg('provider') ?? 'both'; if (!['clef','jev','both'].includes(provider)) throw Error('Unknown provider');
  const providers = provider === 'both' ? ['clef','jev'] : [provider];
  let typesafeKey, cloudflareKey;
  if (providers.includes('jev')) typesafeKey = (await readFile(new URL('.secrets/typesafe-api-key', root), 'utf8')).trim();
  if (providers.includes('clef')) {
    const wrangler = process.env.WRANGLER_CLI;
    if (!wrangler) throw Error('Set WRANGLER_CLI to the installed Wrangler bin/wrangler.js for existing OAuth authentication');
    const auth = execFileSync(process.execPath, [wrangler, 'auth', 'token', '--json'], {encoding:'utf8',
      env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:'/private/tmp/wonderlines-calibration-wrangler.log'},timeout:35000});
    cloudflareKey = JSON.parse(auth).token;
  }
  let done = 0;
  for (const row of document.results) {
    const pending = providers.filter(name => !row[name] || process.argv.includes('--retry-unavailable') && !row[name].scores);
    await Promise.all(pending.map(async name => {
      const started = performance.now();
      try {
        const signal = AbortSignal.timeout(8000);
        let scores;
        if (name === 'jev') scores = await directTypeSafeScores({TYPESAFE_API_KEY: typesafeKey}, row.description, signal);
        else {
          const response = await fetch('https://api.cloudflare.com/client/v4/accounts/994f60c144bd9dd9bc2333bd3abba832/ai/run/@cf/cloudflare/clef', {
            method:'POST',redirect:'manual',signal,headers:{Authorization:'Bearer '+cloudflareKey,'Content-Type':'application/json'},
            body:JSON.stringify(moderationInput(row.description, MODERATION_MODELS.clef)),
          });
          if (!response.ok) { void response.body?.cancel().catch(()=>{}); const error = Error('Unavailable'); error.status = response.status; throw error; }
          scores = moderationScores(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(response,65536))));
        }
        row[name] = {scores, elapsedMs:Math.round(performance.now()-started)};
      } catch (error) {
        row[name] = {error:'unavailable',elapsedMs:Math.round(performance.now()-started),
          ...(Number.isInteger(error.status ?? error.diagnostics?.httpStatus)?{httpStatus:error.status ?? error.diagnostics.httpStatus}:{}),
          failure:error.name==='TimeoutError'?'timeout':error.diagnostics?.failure??'upstream'};
      }
    }));
    document.updatedAt = new Date().toISOString();
    await writeFile(output,JSON.stringify(document,null,2)+'\n');
    if(pending.length) console.log(JSON.stringify({case:row.name,split:row.split,done:++done,total:document.results.length,
      providers:Object.fromEntries(pending.map(name=>[name,row[name].scores?'scored':row[name].failure]))}));
    // Stop immediately on bad credentials/permissions rather than billing a corpus
    // with a service that cannot authenticate. Saved evidence remains resumable.
    if (pending.some(name => [401,403].includes(row[name]?.httpStatus))) throw Error('Calibration credential was rejected; check the saved status, key access and provider billing');
  }
}
const rows = document.results;
const profiles = {}, providers = {};
for (const name of ['clef','jev']) {
  const baseline = document.baselineProfiles?.[name] ?? (name === 'clef' ? moderationThresholds(MODERATION_MODELS.clef) : directJevThresholds);
  const mapped = rows.map(row=>({...row,scores:row[name]?.scores}));
  if (!mapped.some(row=>row.scores)) {providers[name]={status:'awaiting_live_scores'};continue;}
  const train = mapped.filter(row=>row.split==='calibration'), validation = mapped.filter(row=>row.split==='validation');
  const holdout = mapped.filter(row=>row.split==='holdout');
  const fitted = fitThresholds(train,baseline);
  const baselineCalibration = summarize(train,baseline), baselineValidation = summarize(validation,baseline);
  const fittedValidation = summarize(validation,fitted.thresholds);
  // Choose between the fitted profile and its baseline using validation only.
  // A marginal training gain must not override worse validation false rejects.
  const keepBaseline = baselineCalibration.unsafeApproved===0 && baselineValidation.unsafeApproved===0 &&
    (fittedValidation.unsafeApproved>0 || baselineValidation.harmlessApproved >= fittedValidation.harmlessApproved);
  const thresholds = keepBaseline ? baseline : fitted.thresholds;
  profiles[name] = thresholds;
  providers[name] = {thresholds, selection:keepBaseline?'baseline':'fitted',
    method:fitted.method, examinedStates:fitted.examinedStates, searchExhausted:fitted.searchExhausted,
    candidateThresholds:fitted.thresholds, candidateCalibration:fitted.calibration, candidateValidation:fittedValidation,
    baselineCalibration,baselineValidation,baselineHoldout:summarize(holdout,baseline),
    calibration:summarize(train,thresholds),validation:summarize(validation,thresholds),holdout:summarize(holdout,thresholds)};
}
const paired = Object.keys(profiles).length===2 ? {
  calibration:evaluatePair(rows.filter(row=>row.split==='calibration'),profiles),
  validation:evaluatePair(rows.filter(row=>row.split==='validation'),profiles),
  holdout:evaluatePair(rows.filter(row=>row.split==='holdout'),profiles),
} : null;
const ready = Object.keys(profiles).length===2 && ['clef','jev'].every(name =>
  ['calibration','validation','holdout'].every(split=>providers[name][split].unavailable===0 && providers[name][split].unsafeApproved===0));
const report={computedAt:new Date().toISOString(),decisionRule:'first_approval',fixtureHash,rubricHash,jevModel:DIRECT_JEV_MODEL,providers,paired,readyForActivation:ready,
  limitation:'Observed sample results only. Correlated prompts and small holdout size cannot prove future safety. Missing results remain unavailable, never approvals. Only calibration labels fit thresholds; validation selects baseline versus fitted; final holdout labels never participate in either selection.'};
if(arg('report'))await writeFile(arg('report'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({readyForActivation:ready,providers:Object.fromEntries(Object.entries(providers).map(([name,data])=>[name,{status:data.status,thresholds:data.thresholds,calibration:data.calibration,validation:data.validation,holdout:data.holdout}])),paired},null,2));
if(process.argv.includes('--write-profiles')) {
  if(!ready)throw Error('Cannot activate profiles until both services have complete calibration/holdout scores and zero observed unsafe approvals');
  const policyRevision=createHash('sha256').update(JSON.stringify({profiles,rubricHash,model:DIRECT_JEV_MODEL})).digest('hex').slice(0,12);
  const path=new URL('../workers/coloring-sheets-api/src/moderation-profiles.mjs',import.meta.url);
  await writeFile(path,`// Fitted only on calibration examples; holdout evaluated separately.\n// Evidence: ${arg('report')??output}; fixture SHA-256 ${fixtureHash}.\nexport const DIRECT_JEV_MODEL = '${DIRECT_JEV_MODEL}';\nexport const PARALLEL_MODERATION_POLICY = 'all-ages-v10-first-approval-${policyRevision}';\nexport const parallelClefThresholds = Object.freeze(${JSON.stringify(profiles.clef)});\nexport const directJevThresholds = Object.freeze(${JSON.stringify(profiles.jev)});\n`);
}
