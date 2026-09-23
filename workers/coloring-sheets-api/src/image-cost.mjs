// Standard inference prices, checked 2026-09-23:
// https://developers.openai.com/api/docs/pricing
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// Keep pricing keyed by the actual provider/model, never the public picker alias.
const RATES_CHECKED = '2026-09-23';
const OPENAI_RATES = new Map([
  ['gpt-image-2.5-flare', {text: 5, image: 8, output: 30}],
  ['gpt-image-2.5-sunburst', {text: 5, image: 8, output: 30}],
  ['gpt-image-2', {text: 2.5, image: 4, output: 15}]
]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const EXCLUSIONS = 'Inference estimate before credits or free allowances; excludes image conversion, Worker and storage charges. Not a billing receipt.';

export function imageCost(request, result) {
  const unavailable = reason => ({estimatedInputUsd: null, estimatedOutputUsd: null,
    estimatedTotalUsd: null, estimateBasis: reason + ' Missing estimates do not mean free generation.'});
  const estimate = (input, output, basis) => ({estimatedInputUsd: input, estimatedOutputUsd: output,
    estimatedTotalUsd: input + output, ratesChecked: RATES_CHECKED, estimateBasis: basis + ' ' + EXCLUSIONS});

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
    // Bill the actual image (after the adapter's size fitting), not the original
    // client request. Fractional area units match Gateway's observed estimates.
    // These Klein rates already include fixed four-step inference.
    if (request.model === '@cf/black-forest-labs/flux-2-klein-4b') {
      return estimate(0, pixels / (512 * 512) * 0.000287,
        'Cloudflare FLUX.2 Klein 4B: returned pixel area / 512² × $0.000287. Fractional tiles estimated proportionally; no input image charge for a text prompt.');
    }
    if (request.model === '@cf/black-forest-labs/flux-2-klein-9b') {
      return estimate(0, 0.015 + Math.max(0, pixels / (1024 * 1024) - 1) * 0.002,
        'Cloudflare FLUX.2 Klein 9B: $0.015 for the first 1024² pixels, then $0.002 per additional 1024² pixels. Fractional megapixels estimated proportionally; no input image charge for a text prompt.');
    }
  }
  return unavailable('No verified pricing is configured for this provider and upstream model.');
}
