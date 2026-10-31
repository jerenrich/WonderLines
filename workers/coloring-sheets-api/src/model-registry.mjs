import {modelCatalog, validateModelRoute} from './image-provider.mjs';
import initialRegistry from '../model-registry.initial.json' with {type: 'json'};
import {comparisonRoutes} from './fal-models.mjs';

export const MODEL_REGISTRY_KEY = 'catalogue:v1';
const providers = ['openai', 'google-ai-studio', 'workers-ai', 'fal'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

// Validate the entire document before using any of it. A bad edit must never
// resurrect disabled models by falling back to compiled configuration.
export function parseModelRegistry(value) {
  if (!object(value) || !keys(value, ['schemaVersion', 'revision', 'defaultModel', 'providers', 'models']) ||
      value.schemaVersion !== 1 || !text(value.revision, 128) || !object(value.providers) ||
      !keys(value.providers, providers) || !Array.isArray(value.models) || value.models.length > 32) throw new Error('Invalid model registry');
  for (const config of Object.values(value.providers)) {
    if (!object(config) || !keys(config, ['enabled']) || typeof config.enabled !== 'boolean') throw new Error('Invalid provider availability');
  }
  const routes = {}, models = [], ids = new Set();
  for (const entry of value.models) {
    if (!object(entry) || !keys(entry, ['id', 'provider', 'model', 'enabled', 'visible', 'label', 'detail', 'price']) ||
        typeof entry.enabled !== 'boolean' || typeof entry.visible !== 'boolean' ||
        !text(entry.label, 120) || !text(entry.detail, 600) || ids.has(entry.id) || !Object.hasOwn(value.providers, entry.provider)) throw new Error('Invalid model entry');
    const route = {provider: entry.provider, model: entry.model};
    validateModelRoute(entry.id, route);
    if (entry.price !== null && (!object(entry.price) || !keys(entry.price, ['usd', 'evidence', 'explanation']) ||
        !Number.isFinite(entry.price.usd) || entry.price.usd < 0 || entry.price.usd > 100 ||
        !text(entry.price.evidence, 80) || !text(entry.price.explanation, 600))) throw new Error('Invalid reference price');
    ids.add(entry.id);
    if (entry.enabled && value.providers[entry.provider].enabled) {
      routes[entry.id] = route;
      if (entry.visible) models.push({id: entry.id, ...route, label: entry.label, detail: entry.detail, price: entry.price});
    }
  }
  if (value.defaultModel !== null && !ids.has(value.defaultModel)) throw new Error('Invalid default model');
  const defaultModel = models.find(model => model.id === value.defaultModel)?.id ?? models[0]?.id ?? null;
  return {schemaVersion: 1, revision: value.revision, defaultModel, routes, models};
}

export async function loadModelCatalog(env, {comparison = false} = {}) {
  if (env.MODEL_REGISTRY !== undefined) {
    // KV's own cache is the only server cache. Reads may observe an old complete
    // revision during propagation; there are no independently updated flags.
    const raw = await env.MODEL_REGISTRY.get(MODEL_REGISTRY_KEY, {type: 'text', cacheTtl: 60});
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 65536) throw new Error('Model registry unavailable');
    const document = JSON.parse(raw), catalogue = parseModelRegistry(document);
    // The private comparison studio has additional experimental fal presets.
    // Keep those separate from the app picker, but honour the provider switch.
    if (comparison && document.providers.fal?.enabled) {
      for (const [id, route] of Object.entries(comparisonRoutes())) {
        if (!document.models.some(entry => entry.id === id)) catalogue.routes[id] = route;
      }
    }
    return catalogue;
  }
  // Compatibility for deployments not yet bound to KV and isolated legacy tests.
  // Once bound, missing documents and read/validation failures always fail closed.
  const legacy = modelCatalog(env, {comparison});
  const defaults = new Map(initialRegistry.models.map(model => [model.id, model]));
  const models = Object.entries(legacy.routes).filter(([id]) => defaults.get(id)?.visible !== false).map(([id, route]) => {
    const entry = defaults.get(id);
    const sameRoute = entry?.provider === route.provider && entry?.model === route.model;
    return {id, ...route, label: entry?.label ?? id, detail: sameRoute ? entry.detail : 'Image generation model.', price: sameRoute ? entry.price : null};
  });
  return {schemaVersion: 1, revision: 'legacy', ...legacy, models};
}
