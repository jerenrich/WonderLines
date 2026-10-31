// Validate before uploading a complete catalogue document to KV. This command
// only reads local files and never changes production configuration.
import {readFile} from 'node:fs/promises';
import {parseModelRegistry} from '../workers/coloring-sheets-api/src/model-registry.mjs';
const path = process.argv[2] ?? 'workers/coloring-sheets-api/model-registry.initial.json';
try {
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > 65536) throw new Error('Model registry exceeds 64 KiB');
  const catalogue = parseModelRegistry(JSON.parse(raw));
  console.log(`Valid catalogue ${catalogue.revision}: ${catalogue.models.length} visible models, ${Object.keys(catalogue.routes).length} enabled routes; default ${catalogue.defaultModel ?? '(paused)'}.`);
} catch (error) {
  console.error(`Invalid catalogue: ${error.message}`);
  process.exitCode = 1;
}
