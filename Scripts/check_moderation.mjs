// Explicit live text-only evaluation. Does not register accounts or generate images.
import {readFileSync} from 'node:fs';
import {moderationInput, moderationDecision, moderationResult, moderationModel} from '../workers/coloring-sheets-api/src/moderation.mjs';

const {CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token,
  MODERATION_GATEWAY_ID: gateway} = process.env;
if (!process.argv.includes('--live') || !/^[a-fA-F0-9]{32}$/.test(account ?? '') ||
    !token || !/^[A-Za-z0-9_-]{1,64}$/.test(gateway ?? '')) {
  console.error('For paid text-only checks, pass --live and set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (AI Gateway Run), and MODERATION_GATEWAY_ID securely in the environment.');
  process.exit(1);
}
const model = moderationModel(process.env);
const onlyArg = process.argv.find(arg => arg.startsWith('--cases='));
const selected = onlyArg?.slice('--cases='.length).split(',');
const fixtureFiles = ['moderation-cases.json', ...(process.argv.includes('--validation') ? ['moderation-validation-cases.json'] : [])];
const cases = fixtureFiles.flatMap(file => JSON.parse(readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8')))
  .filter(test => !selected || selected.includes(test.name));
if (!cases.length) { console.error('No matching moderation cases.'); process.exit(1); }
let failures = 0, inputTokens = 0;
for (const test of cases) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'cf-aig-gateway-id': gateway, 'cf-aig-skip-cache': 'true',
        'cf-aig-collect-log': 'false', 'cf-aig-max-attempts': '1'},
      body: JSON.stringify(moderationInput(test.description, model)),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const envelope = await response.json();
    if (envelope.success !== true) throw new Error('Unsuccessful Cloudflare response');
    const result = moderationResult(envelope);
    const allowed = moderationDecision(result, model);
    if (allowed !== test.allowed) {
      failures++; console.log('FAIL: ' + test.name + ' (expected ' + test.allowed + ', received ' + allowed + ')');
      console.log(JSON.stringify(Object.fromEntries(Object.keys(moderationInput('').questions).map(name => [name, result.answers[name].noul]))));
    }
    else console.log('PASS: ' + test.name);
    inputTokens += result.usage?.input_tokens ?? 0;
  } catch {
    console.error('Live moderation check failed at ' + test.name + '. Check gateway access, credits, and configuration. No automatic retries were made.');
    process.exit(1);
  }
}
console.log(`${cases.length - failures}/${cases.length} policy cases passed; ${inputTokens} input tokens. No images generated.`);
process.exitCode = failures ? 1 : 0;
