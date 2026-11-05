// Produce a validated local catalogue for review; no network or live writes.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseModelRegistry} from '../workers/coloring-sheets-api/src/model-registry.mjs';

export function upgradeImageModels(source, revision = `image26-low-${crypto.randomUUID()}`) {
  parseModelRegistry(source);
  if (!source.providers.openai?.enabled) throw new Error('OpenAI must already be enabled before upgrading.');
  const document = structuredClone(source);
  const upgrades = ['flare', 'sunburst'].map(variant => ({
    id: `gpt-image-2.6-${variant}-low`, provider: 'openai', model: `gpt-image-2.6-${variant}`, complexity: 'low',
    enabled: true, visible: true, label: `${variant === 'flare' ? 'Flare' : 'Sunburst'} (2.6)`,
    detail: 'Uses GPT Image 2.6 with low planning complexity for faster coloring-page generation.', price: null
  }));
  document.models = [...upgrades, ...document.models.filter(entry => !upgrades.some(upgrade => upgrade.id === entry.id)).map(entry =>
    ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].includes(entry.id) ? {...entry, visible: false, comparisonOnly: true} : entry)];
  document.defaultModel = 'gpt-image-2.6-flare-low';
  document.revision = revision;
  parseModelRegistry(document);
  parseModelRegistry(document, {comparison: true});
  return document;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node Scripts/upgrade_image_models.mjs source.json proposed.json');
  const document = upgradeImageModels(JSON.parse(await readFile(source, 'utf8')));
  await writeFile(destination, JSON.stringify(document, null, 2) + '\n');
  console.log(`Validated ${document.revision}; default ${document.defaultModel}. Written locally to ${destination}.`);
}
