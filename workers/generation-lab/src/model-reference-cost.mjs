import {imageCost} from '../../coloring-sheets-api/src/image-cost.mjs';

// Reference prices from the 2026-10-23 audit, keyed by actual upstream route.
// These describe audited presets/samples, not a promise about the next bill.
export function modelReferenceCost({provider, model}) {
  const checkedOn = '2026-10-23';
  if (provider === 'fal' && model === 'z-image-turbo') return {
    usd: 0.01, billingConfirmed: true, checkedOn,
    basis: 'Four 1456×1024 images matched fal billing events at 2 billable megapixels each. Reference price; future charges may vary.'
  };
  if (provider === 'openai' && ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].includes(model)) return {
    usd: 0.005203125, billingConfirmed: false, checkedOn,
    basis: 'Average token-based estimate across 32 audited images for this model; no matched per-image billing receipt. Actual cost varies with usage.'
  };
  if (provider === 'workers-ai') {
    const steps = new Map([['@cf/black-forest-labs/flux-2-dev', 25], ['@cf/black-forest-labs/flux-1-schnell', 4],
      ['@cf/leonardo/lucid-origin', 25], ['@cf/leonardo/phoenix-1.0', 25], ['@cf/lykon/dreamshaper-8-lcm', 8]]).get(model);
    const size = model === '@cf/black-forest-labs/flux-1-schnell' ? '1024x1024' : '1456x1024';
    const cost = imageCost({provider, model, payload: {num_steps: steps}}, {size});
    if (cost.estimatedTotalUsd != null) return {usd: cost.estimatedTotalUsd, billingConfirmed: false, checkedOn,
      basis: `Reference preset ${size}${steps ? `, ${steps} steps` : ''}. ${cost.estimateBasis}`};
  }
  return null;
}
