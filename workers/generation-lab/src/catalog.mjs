import {loadModelCatalog} from '../../coloring-sheets-api/src/model-registry.mjs';
import {modelCatalog} from '../../coloring-sheets-api/src/image-provider.mjs';
import {refreshImageCostMetrics} from '../../coloring-sheets-api/src/image-cost.mjs';
import {modelReferenceCost} from './model-reference-cost.mjs';
import {FAL_COMPARISON_MODELS} from '../../coloring-sheets-api/src/fal-models.mjs';
const names = {'gpt-image-2.5-flare': 'Flare', 'gpt-image-2.5-sunburst': 'Sunburst', 'flux-2-klein-4b': 'FLUX.2 Klein 4B', 'flux-2-klein-9b': 'FLUX.2 Klein 9B', 'flux-2-dev': 'FLUX.2 Dev', 'flux-1-schnell': 'FLUX.1 Schnell', 'lucid-origin': 'Lucid Origin', 'phoenix-1.0': 'Phoenix 1.0', 'stable-diffusion-xl-base-1.0': 'Stable Diffusion XL', 'stable-diffusion-xl-lightning': 'SDXL Lightning', 'dreamshaper-8-lcm': 'DreamShaper 8 LCM'};
const recommended = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'z-image-turbo', 'flux-2-klein-4b', 'flux-2-klein-9b', 'phoenix-1.0'];
// Distilled and undistilled Klein are different checkpoints. Put the variant
// and actual sampling steps in the picker label so they do not look duplicated.
const kleinLabels = {
  'flux-2-klein-4b': 'FLUX.2 Klein 4B (Fast, 4 steps)',
  'flux-2-klein-9b': 'FLUX.2 Klein 9B (Fast, 4 steps)',
  'flux-2-klein-base-4b': 'FLUX.2 Klein 4B (Base, 28 steps)',
  'flux-2-klein-base-9b': 'FLUX.2 Klein 9B (Base, 28 steps)'
};
export function catalog(env) {
  const result = modelCatalog(env, {comparison: true});
  return Object.entries(result.routes).map(([id, route]) => ({id,
    label: kleinLabels[id] ?? FAL_COMPARISON_MODELS[id]?.label ?? (id === 'coloringbook-redmond-v2' ? 'ColoringBook Redmond V2' : names[id] ?? id),
    recommended: recommended.includes(id), ...route, referenceCost: modelReferenceCost(route)}));
}
// Use the same KV-backed routes as generation admission. Comparison-only
// presets remain available when their provider is enabled.
export async function liveCatalog(env) {
  if (!env.MODEL_REGISTRY) return catalog(env);
  const result = await loadModelCatalog(env, {comparison:true});
  const defaults = new Map(catalog(env).map(model => [model.id, model]));
  const visible = new Map(result.models.map(model => [model.id, model]));
  return Object.entries(result.routes).map(([id, route]) => {
    const prior = defaults.get(id), entry = visible.get(id);
    return {id, ...route, label:entry?.label ?? prior?.label ?? id,
      recommended:entry ? true : (prior?.recommended ?? false),
      referenceCost:modelReferenceCost(route)};
  });
}
// These are visible as setup information, never selectable pretend integrations.
export const unavailableModels = [
  {label:'Krea 2 RAW',reason:'Needs a custom GPU endpoint; use Krea 2 Turbo for hosted generation.'},
  {label:'Chroma1-Base / Flash',reason:'Needs a custom GPU endpoint or another hosted provider.'},
  {label:'Flex.2-preview',reason:'Needs a custom GPU endpoint or another hosted provider; distinct from FLUX.2 Flex.'},
  {label:'Qwen-Image-2.1 Turbo',reason:'Needs an Alibaba Cloud integration or a licensed custom endpoint; Qwen-Image 2512 is a different model.'}
];
export function publicJob(job, access) {
  return {id: job.id, status: job.state, createdAt: job.createdAt, metrics: (job.state === 'completed' ? refreshImageCostMetrics(job.metrics) : job.metrics) ?? null,
    ...(job.state === 'completed' ? {imageUrl: `/api/images/${job.id}`} : {}),
    ...(job.state === 'failed' ? {error: {code: job.errorCode, message: job.message}} : {}), access};
}
