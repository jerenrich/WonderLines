// Comparison-only presets. Endpoint schemas checked against fal's /api pages
// on 2026-10-27. Never accept arbitrary endpoint IDs or LoRA URLs from clients.
export const FAL_COMPARISON_MODELS = {
  'z-image': {label: 'Z-Image Base', model: 'fal-ai/z-image/base', negative: true, parameters: {num_inference_steps: 28, guidance_scale: 4}},
  'z-image-turbo': {label: 'Z-Image Turbo', model: 'fal-ai/z-image/turbo', parameters: {num_inference_steps: 8, enable_prompt_expansion: false}},
  'sana': {label: 'SANA', model: 'fal-ai/sana', negative: true, parameters: {num_inference_steps: 18, guidance_scale: 5, style_name: '(No style)'}},
  'sana-sprint': {label: 'SANA-Sprint', model: 'fal-ai/sana/sprint', negative: true, parameters: {num_inference_steps: 2, guidance_scale: 5, style_name: '(No style)'}},
  'ernie-image': {label: 'ERNIE-Image', model: 'fal-ai/ernie-image', negative: true, parameters: {num_inference_steps: 50, guidance_scale: 4, enable_prompt_expansion: false}},
  'ernie-image-turbo': {label: 'ERNIE-Image Turbo', model: 'fal-ai/ernie-image/turbo', negative: true, parameters: {num_inference_steps: 8, guidance_scale: 1, enable_prompt_expansion: false}},
  'lumina-image-2': {label: 'Lumina-Image 2.0', model: 'fal-ai/lumina-image/v2', negative: true, parameters: {num_inference_steps: 30, guidance_scale: 4, cfg_normalization: true, cfg_trunc_ratio: 1}},
  'krea-2-turbo': {label: 'Krea 2 Turbo', model: 'fal-ai/krea-2/turbo', parameters: {enable_prompt_expansion: false}},
  'flux-2-klein-base-4b': {label: 'FLUX.2 Klein Base 4B', model: 'fal-ai/flux-2/klein/4b/base', negative: true, parameters: {num_inference_steps: 28, guidance_scale: 5}},
  'flux-2-klein-base-9b': {label: 'FLUX.2 Klein Base 9B', model: 'fal-ai/flux-2/klein/9b/base', negative: true, parameters: {num_inference_steps: 28, guidance_scale: 5}},
  'qwen-image': {label: 'Qwen-Image', model: 'fal-ai/qwen-image', negative: true, parameters: {num_inference_steps: 30, guidance_scale: 2.5, use_turbo: false}},
  'qwen-image-2512': {label: 'Qwen-Image 2512', model: 'fal-ai/qwen-image-2512', negative: true, parameters: {num_inference_steps: 28, guidance_scale: 4}}
};
export const falComparisonConfig = model => Object.values(FAL_COMPARISON_MODELS).find(config => config.model === model);
export const comparisonRoutes = () => Object.fromEntries(Object.entries(FAL_COMPARISON_MODELS).map(([id, config]) => [id, {provider: 'fal', model: config.model}]));
export const isFalEndpoint = model => model === 'fal-ai/lora' || !!falComparisonConfig(model);
