// Standard inference prices, checked 2026-10-23:
// https://developers.openai.com/api/docs/pricing
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// Keep pricing keyed by the actual provider/model, never the public picker alias.
const RATES_CHECKED = '2026-10-23';
const ESTIMATE_VERSION = 3;
const OPENAI_RATES = new Map([
  ['gpt-image-2.5-flare', {text: 5, image: 8, output: 30}],
  ['gpt-image-2.5-sunburst', {text: 5, image: 8, output: 30}],
  // The collapsed pricing page also contains Batch prices. This adapter calls
  // the synchronous Images API, so GPT Image 2 uses Standard prices too.
  ['gpt-image-2', {text: 5, image: 8, output: 30}]
]);
const USD_PER_NEURON = 0.011 / 1000;
// Base neurons per 512² output tile, plus neurons per tile per inference step.
// Lucid and Schnell reconcile to the observed Gateway costs; Dev uses the
// published neuron rate (its displayed USD rate is rounded to $0.00041).
const TILE_RATES = new Map([
  ['@cf/black-forest-labs/flux-2-klein-4b', {base: 26.05, step: 0}],
  ['@cf/black-forest-labs/flux-2-dev', {base: 0, step: 37.5}],
  ['@cf/black-forest-labs/flux-1-schnell', {base: 4.8, step: 9.6}],
  ['@cf/leonardo/lucid-origin', {base: 636, step: 12}],
  ['@cf/leonardo/phoenix-1.0', {base: 530, step: 10}]
]);
const FREE_BETA_MODELS = new Set([
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/bytedance/stable-diffusion-xl-lightning'
]);
// Documented server presets used by saved jobs before step counts were retained.
const LEGACY_STEPS = new Map([
  ['@cf/black-forest-labs/flux-2-dev', 25],
  ['@cf/black-forest-labs/flux-1-schnell', 4],
  ['@cf/leonardo/lucid-origin', 25],
  ['@cf/leonardo/phoenix-1.0', 25],
  ['@cf/lykon/dreamshaper-8-lcm', 8]
]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const EXCLUSIONS = 'Inference estimate before credits or free allowances; excludes image conversion, Worker and storage charges. Not a billing receipt.';

export function imageCost(request, result) {
  const unavailable = reason => ({estimatedInputUsd: null, estimatedOutputUsd: null,
    estimatedTotalUsd: null, costStatus: 'unavailable', estimateBasis: reason + ' Missing estimates do not mean free generation.'});
  const estimate = (input, output, basis) => ({estimatedInputUsd: input, estimatedOutputUsd: output,
    estimatedTotalUsd: input + output, costStatus: 'estimated', ratesChecked: RATES_CHECKED,
    costEstimateVersion: ESTIMATE_VERSION, estimateBasis: basis + ' ' + EXCLUSIONS});

  if (request.provider === 'fal') {
    const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const pricing = {ratesChecked: (result.unitPriceCheckedAt ?? result.costCheckedAt)?.slice(0, 10)};
    if (valid(result.reportedCostUsd)) {
      return {...estimate(0, result.reportedCostUsd,
        'fal per-request billing event: provider-reported charge after discounts, before any account-credit adjustments.'),
        ...pricing, costStatus: 'reported', costEvidence: 'billing_event'};
    }
    if (valid(result.billableUnits) && valid(result.unitPriceUsd) && result.billingUnit &&
        Number.isFinite(result.billableUnits * result.unitPriceUsd)) {
      return {...estimate(0, result.billableUnits * result.unitPriceUsd,
        `fal reported ${result.billableUnits} billable units × $${result.unitPriceUsd} per ${result.billingUnit}. Captured endpoint pricing; a per-request billing record is not yet available.`),
        ...pricing, costStatus: 'estimated', costEvidence: 'billable_units'};
    }
    if (valid(result.inferenceMs) && result.inferenceMs > 0 && valid(result.unitPriceUsd) &&
        ['compute second', 'compute seconds'].includes(result.billingUnit) &&
        Number.isFinite(result.inferenceMs / 1000 * result.unitPriceUsd)) {
      return {...estimate(0, result.inferenceMs / 1000 * result.unitPriceUsd,
        `Inference-time estimate: ${(result.inferenceMs / 1000).toFixed(3)} recorded inference seconds × $${result.unitPriceUsd} per compute second. fal has not supplied billable units or an accessible billing record. Model loading and other billed overhead may increase the actual charge; this is not measured billable time.`),
        ...pricing, costStatus: 'estimated', costEvidence: 'inference_time_proxy'};
    }
    return {...unavailable('fal billing units or verified USD pricing are unavailable. Request ID and inference timing are retained for reconciliation; elapsed time is not billable time.'),
      ...pricing, costStatus: 'unavailable'};
  }

  if (request.provider === 'openai') {
    const rates = OPENAI_RATES.get(request.model);
    if (!rates) return unavailable('No verified OpenAI pricing is configured for this upstream model.');
    // This adapter sends only a text prompt. If the provider supplies a modality
    // breakdown, retain it; otherwise aggregate input is all text for this request.
    const image = count(result.imageInputTokens) ?? 0;
    let text = count(result.textInputTokens);
    if (text === null && count(result.inputTokens) !== null && result.inputTokens >= image) text = result.inputTokens - image;
    let output = count(result.outputTokens);
    if (output === null && count(result.totalTokens) !== null && count(result.inputTokens) !== null && result.totalTokens >= result.inputTokens) {
      output = result.totalTokens - result.inputTokens;
    }
    if (output === null) return unavailable('OpenAI did not return enough token usage to estimate image output cost.');
    let basis = 'OpenAI reported token usage at standard text/image input and image output rates.';
    if (text === null) {
      // Only input can be approximated this way. Image output tokens do not scale
      // linearly with pixel area, so never guess those from another image model.
      if (typeof request.payload?.prompt !== 'string') return unavailable('OpenAI text input usage and the original prompt are unavailable.');
      text = Math.ceil(Array.from(request.payload.prompt).length / 4);
      basis = 'OpenAI reported output usage; missing text input usage approximated at four characters per token.';
    }
    // Image generations currently expose no guaranteed cache breakdown. Apply
    // a discount only when the returned cached count can be assigned to text.
    const cached = image === 0 ? Math.min(count(result.cachedInputTokens) ?? 0, text) : 0;
    const input = ((text - cached) * rates.text + cached * rates.text / 4 + image * rates.image) / 1e6;
    basis += cached ? ' Reported cached text tokens use the cached rate.' : ' No cache discount assumed.';
    return estimate(input, output * rates.output / 1e6, basis);
  }

  if (request.provider === 'workers-ai') {
    const dimensions = /^(\d+)x(\d+)$/.exec(result.size ?? '');
    const pixels = dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0;
    if (!Number.isSafeInteger(pixels) || pixels <= 0) return unavailable('Returned image dimensions are missing or invalid.');
    if (FREE_BETA_MODELS.has(request.model)) {
      return {...estimate(0, 0,
        'Cloudflare model catalog explicitly lists this beta model at $0 per inference step as of the rate check. This is a published zero inference rate, not an inference from missing usage or an account allowance.'),
        costStatus: 'estimated', costEvidence: 'published_zero_rate'};
    }
    const payload = request.payload;
    const rawSteps = payload instanceof FormData ? payload.get('steps') ?? payload.get('num_steps')
      : payload?.steps ?? payload?.num_steps ?? result.inferenceSteps;
    const steps = typeof rawSteps === 'string' && /^\d+$/.test(rawSteps) ? Number(rawSteps) : rawSteps;
    // Authenticated aiInferenceAdaptive records (sampleInterval=1), checked
    // 2026-10-23. Scope observations to the measured server preset; one size
    // cannot establish a general dimension/step pricing formula.
    if (request.model === '@cf/lykon/dreamshaper-8-lcm') {
      if (result.size !== '1456x1024' || steps !== 8) {
        return unavailable('DreamShaper has no verified published rate. Observed neuron usage covers only the 1456x1024, 8-step server preset; this request is outside that evidence.');
      }
      return {...estimate(0, 0.248 * USD_PER_NEURON,
        'Cloudflare DreamShaper: four successful unsampled Workers AI metering records on 2026-10-22 each report 0.248 neurons for 1456x1024 output. Uses the matching 8-step server preset: 0.248 × $0.011 / 1,000 neurons. Observed preset estimate, not a published rate or a request-ID-matched receipt.'),
        inferenceSteps: steps, costEvidence: 'observed_neuron_usage'};
    }
    const rates = TILE_RATES.get(request.model);
    if (rates) {
      if (rates.step && (!Number.isSafeInteger(steps) || steps < 1 || steps > 50)) {
        return unavailable('The inference step count is missing or invalid for this Cloudflare model.');
      }
      if (request.model === '@cf/leonardo/phoenix-1.0') {
        const tiles = Math.max(1, Math.floor(pixels / (512 * 512)));
        return {...estimate(0, tiles * (rates.base + rates.step * steps) * USD_PER_NEURON,
          `Cloudflare Phoenix: ${tiles} estimated billable tiles × (530 + 10 × ${steps} steps) neurons × $0.011 / 1,000. Whole tiles inferred by flooring returned pixel area / 512², with a one-tile minimum. The landscape 1456x1024, 25-step preset reconciles exactly with 19 unsampled requests at 5 tiles and 3,900 neurons each; wider metering also reports whole counts of 3 and 7 tiles. Other sizes/steps use this inferred tile rule, not a published rounding guarantee or request-ID-matched receipt.`),
          inferenceSteps: steps, costEvidence: result.size === '1456x1024' && steps === 25 ? 'observed_neuron_usage' : 'metering_inferred_tile_rule'};
      }
      const tiles = pixels / (512 * 512);
      return {...estimate(0, tiles * (rates.base + rates.step * (rates.step ? steps : 0)) * USD_PER_NEURON,
        `Cloudflare ${request.model}: returned pixel area / 512² × (${rates.base} base neurons + ${rates.step} neurons × ${rates.step ? steps : 0} inference steps) × $0.011 / 1,000 neurons. Fractional tiles estimated proportionally; no input image charge for a text prompt.`),
        ...(rates.step ? {inferenceSteps: steps} : {}), costStatus: 'estimated', costEvidence: 'published_neuron_rate'};
    }
    if (request.model === '@cf/black-forest-labs/flux-2-klein-9b') {
      return {...estimate(0, 0.015 + Math.max(0, pixels / (1024 * 1024) - 1) * 0.002,
        'Cloudflare FLUX.2 Klein 9B: $0.015 for the first 1024² pixels, then $0.002 per additional 1024² pixels. Fractional megapixels estimated proportionally; no input image charge for a text prompt.'),
        costStatus: 'estimated', costEvidence: 'published_rate'};
    }
  }
  return unavailable('No verified pricing is configured for this provider and upstream model.');
}

// Enrich completed records on reads without regenerating images, rewriting old
// receipts, or applying a public alias's current route to a historical job.
export function refreshImageCostMetrics(metrics) {
  if (!metrics || metrics.provider === 'fal' || metrics.costStatus === 'reported' ||
      (metrics.ratesChecked === RATES_CHECKED && metrics.costEstimateVersion === ESTIMATE_VERSION) || !metrics.upstreamModel) return metrics;
  if (metrics.provider === 'openai' && metrics.upstreamModel !== 'gpt-image-2' && metrics.estimatedTotalUsd != null) return metrics;
  const request = {provider: metrics.provider, model: metrics.upstreamModel};
  const historicalSteps = metrics.inferenceSteps == null ? LEGACY_STEPS.get(metrics.upstreamModel) : null;
  const cost = imageCost(request, {...metrics, ...(historicalSteps ? {inferenceSteps: historicalSteps} : {})});
  // Do not replace a usable historical estimate with incomplete current data.
  if (cost.estimatedTotalUsd == null) return metrics.estimatedTotalUsd != null ? metrics : {...metrics, ...cost};
  if (historicalSteps) cost.estimateBasis += ` Saved job did not retain steps; assumes the documented ${historicalSteps}-step server preset used by this model.`;
  return {...metrics, ...cost};
}
