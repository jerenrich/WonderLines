// Live text-only comparison using Wrangler's existing login; no images generated.
import {createRequire} from 'node:module';
import {MODERATION_MODELS, moderationInput, moderationScores, moderationDecision} from '../workers/coloring-sheets-api/src/moderation.mjs';
const subject = process.argv.find(arg => arg.startsWith('--description='))?.slice(14);
if (!process.argv.includes('--live') || !subject?.trim()) {
  console.error('Usage: node Scripts/compare_moderation.mjs --live --description="your description"');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const {getPlatformProxy} = require(process.env.WRANGLER_MODULE ?? 'wrangler');
const proxy = await getPlatformProxy({configPath: process.env.MODERATION_PROXY_CONFIG ?? new URL('../workers/coloring-sheets-api/wrangler.jsonc', import.meta.url).pathname, persist: false, remoteBindings: true});
try {
  for (const [name, model] of Object.entries(MODERATION_MODELS)) {
    const started = Date.now();
    try {
      const result = await proxy.env.AI.run(model, moderationInput(subject, model), {
        gateway: {id: proxy.env.AI_GATEWAY_ID ?? proxy.env.MODERATION_GATEWAY_ID ?? 'coloring-sheets', skipCache: true, collectLog: true},
      });
      console.log(JSON.stringify({model: name, scores: moderationScores(result), allowed: moderationDecision(result, model), elapsedMs: Date.now() - started}));
    } catch {
      console.error(JSON.stringify({model: name, error: 'moderation_unavailable'}));
      process.exitCode = 1;
    }
  }
} finally { await proxy.dispose(); }
