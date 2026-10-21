import {modelCatalog} from '../../coloring-sheets-api/src/image-provider.mjs';
const names = {'gpt-image-2.5-flare': 'Flare', 'gpt-image-2.5-sunburst': 'Sunburst', 'flux-2-klein-4b': 'FLUX.2 Klein 4B', 'flux-2-klein-9b': 'FLUX.2 Klein 9B', 'flux-2-dev': 'FLUX.2 Dev', 'flux-1-schnell': 'FLUX.1 Schnell', 'lucid-origin': 'Lucid Origin', 'phoenix-1.0': 'Phoenix 1.0', 'stable-diffusion-xl-base-1.0': 'Stable Diffusion XL', 'stable-diffusion-xl-lightning': 'SDXL Lightning', 'dreamshaper-8-lcm': 'DreamShaper 8 LCM'};
const recommended = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'flux-2-klein-4b', 'flux-2-klein-9b', 'phoenix-1.0'];
export function catalog(env) {
  const result = modelCatalog(env);
  // fal requires a separate queue submission protocol; launch with the app's
  // five selectable models plus supported alternatives using the image queue.
  return Object.entries(result.routes).filter(([, route]) => route.provider !== 'fal').map(([id, route]) => ({id, label: names[id] ?? id, recommended: recommended.includes(id), ...route}));
}
export function publicJob(job, access) {
  return {id: job.id, status: job.state, createdAt: job.createdAt, metrics: job.metrics ?? null,
    ...(job.state === 'completed' ? {imageUrl: `/api/images/${job.id}`} : {}),
    ...(job.state === 'failed' ? {error: {code: job.errorCode, message: job.message}} : {}), access};
}
