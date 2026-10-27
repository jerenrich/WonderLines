import {modelCatalog} from '../../coloring-sheets-api/src/image-provider.mjs';
import {FAL_COMPARISON_MODELS} from '../../coloring-sheets-api/src/fal-models.mjs';
const names = {'gpt-image-2.5-flare': 'Flare', 'gpt-image-2.5-sunburst': 'Sunburst', 'flux-2-klein-4b': 'FLUX.2 Klein 4B', 'flux-2-klein-9b': 'FLUX.2 Klein 9B', 'flux-2-dev': 'FLUX.2 Dev', 'flux-1-schnell': 'FLUX.1 Schnell', 'lucid-origin': 'Lucid Origin', 'phoenix-1.0': 'Phoenix 1.0', 'stable-diffusion-xl-base-1.0': 'Stable Diffusion XL', 'stable-diffusion-xl-lightning': 'SDXL Lightning', 'dreamshaper-8-lcm': 'DreamShaper 8 LCM'};
const recommended = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'flux-2-klein-4b', 'flux-2-klein-9b', 'phoenix-1.0'];
export function catalog(env) {
  const result = modelCatalog(env, {comparison: true});
  return Object.entries(result.routes).map(([id, route]) => ({id,
    label: FAL_COMPARISON_MODELS[id]?.label ?? (id === 'coloringbook-redmond-v2' ? 'ColoringBook Redmond V2' : names[id] ?? id),
    recommended: recommended.includes(id), ...route}));
}
// These are visible as setup information, never selectable pretend integrations.
export const unavailableModels = [
  {label:'Krea 2 RAW',reason:'Needs a custom GPU endpoint; use Krea 2 Turbo for hosted generation.'},
  {label:'Chroma1-Base / Flash',reason:'Needs a custom GPU endpoint or another hosted provider.'},
  {label:'Flex.2-preview',reason:'Needs a custom GPU endpoint or another hosted provider; distinct from FLUX.2 Flex.'},
  {label:'Qwen-Image-2.1 Turbo',reason:'Needs an Alibaba Cloud integration or a licensed custom endpoint; Qwen-Image 2512 is a different model.'}
];
export function publicJob(job, access) {
  return {id: job.id, status: job.state, createdAt: job.createdAt, metrics: job.metrics ?? null,
    ...(job.state === 'completed' ? {imageUrl: `/api/images/${job.id}`} : {}),
    ...(job.state === 'failed' ? {error: {code: job.errorCode, message: job.message}} : {}), access};
}
