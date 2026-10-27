import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {imageCost, refreshImageCostMetrics} from '../workers/coloring-sheets-api/src/image-cost.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const request = (model, provider = 'openai') => ({model, provider, payload: {prompt: 'A friendly flower'}});
for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  const cost = imageCost(request(model), {inputTokens: 100, textInputTokens: 80, imageInputTokens: 20, outputTokens: 200});
  close(cost.estimatedInputUsd, 0.00056);
  close(cost.estimatedOutputUsd, 0.006);
  close(cost.estimatedTotalUsd, 0.00656);
  assert.equal(cost.ratesChecked, '2026-10-23');
  const textOnly = imageCost(request(model), {inputTokens: 100, outputTokens: 200});
  close(textOnly.estimatedTotalUsd, 0.0065);
  const cached = imageCost(request(model), {inputTokens: 100, cachedInputTokens: 80, outputTokens: 200});
  close(cached.estimatedInputUsd, 0.0002);
  const inferredOutput = imageCost(request(model), {inputTokens: 100, totalTokens: 300});
  close(inferredOutput.estimatedTotalUsd, 0.0065);
  const approximateInput = imageCost(request(model), {outputTokens: 200});
  close(approximateInput.estimatedTotalUsd, 0.006025);
  assert.match(approximateInput.estimateBasis, /approximated/);
  for (const outputTokens of [undefined, null, -1, '200', Infinity, NaN, 0.5]) {
    const missing = imageCost(request(model), {inputTokens: 100, outputTokens});
    assert.equal(missing.estimatedTotalUsd, null, 'Missing/invalid usage cannot imply a free image.');
    assert.match(missing.estimateBasis, /enough token usage/);
  }
  assert.equal(imageCost(request(model), {inputTokens: 0, outputTokens: 0}).estimatedTotalUsd, 0);
}
close(imageCost(request('gpt-image-2'), {inputTokens: 100, outputTokens: 200}).estimatedTotalUsd, 0.0065);
// Never apply a picker's OpenAI rates to a remapped/unknown upstream model or provider.
for (const route of [request('another-image-model'), request('gpt-image-2.5-flare', 'google-ai-studio'),
  request('gemini-2.5-flash-image', 'google-ai-studio'), request('@cf/unknown', 'workers-ai')]) {
  assert.equal(imageCost(route, {inputTokens: 100, outputTokens: 200, size: '1024x1024'}).estimatedTotalUsd, null);
}
for (const [size, cost4B, cost9B] of [
  ['1024x1024', 0.0011462, 0.015],
  ['1024x1456', 0.001629753125, 0.01584375],
  ['1456x1024', 0.001629753125, 0.01584375],
  ['1920x1328', 0.002787146484375, 0.01786328125],
  ['512x512', 0.00028655, 0.015]
]) {
  for (const [model, expected] of [['4b', cost4B], ['9b', cost9B]]) {
    const cost = imageCost(request('@cf/black-forest-labs/flux-2-klein-' + model, 'workers-ai'), {size});
    assert.equal(cost.estimatedInputUsd, 0);
    close(cost.estimatedOutputUsd, expected);
    close(cost.estimatedTotalUsd, expected);
    assert.match(cost.estimateBasis, /before credits or free allowances/);
    assert.match(cost.estimateBasis, /excludes image conversion/);
  }
}
for (const size of [undefined, '', 'auto', '0x1024', '-1x1024', 'Infinityx1024']) {
  assert.equal(imageCost(request('@cf/black-forest-labs/flux-2-klein-4b', 'workers-ai'), {size}).estimatedTotalUsd, null);
}
console.log('PASS: provider-specific inference estimates, fractional image area, token breakdowns, missing usage, and unknown pricing.');

// Billing observations for the 1456×1024, 25-step comparison preset. The
// displayed Gateway aggregates round four Lucid images to $0.2342, three Dev
// images to $0.1760, and four 1024²/4-step Schnell images to $0.0076.
for (const [model, size, steps, expected] of [
  ['@cf/black-forest-labs/flux-2-dev', '1456x1024', 25, 0.05865234375],
  ['@cf/black-forest-labs/flux-1-schnell', '1024x1024', 4, 0.0019008],
  ['@cf/leonardo/lucid-origin', '1456x1024', 25, 0.0585585]
]) {
  const native = {model, provider: 'workers-ai', payload: {num_steps: steps}};
  const cost = imageCost(native, {size});
  close(cost.estimatedTotalUsd, expected);
  assert.equal(cost.inferenceSteps, steps);
  assert.equal(cost.costEvidence, 'published_neuron_rate');
  // Both dimensions and step work matter; each step is charged per tile.
  const doubleArea = size === '1024x1024' ? '2048x1024' : '2912x1024';
  close(imageCost(native, {size: doubleArea}).estimatedTotalUsd, expected * 2);
  assert.ok(imageCost({...native, payload: {steps: steps + 1}}, {size}).estimatedTotalUsd > expected);
  for (const invalid of [undefined, null, 0, -1, '25oops', 0.5, Infinity, 51]) {
    assert.equal(imageCost({...native, payload: {steps: invalid}}, {size}).estimatedTotalUsd, null);
  }
  close(imageCost({model, provider: 'workers-ai'}, {size, inferenceSteps: steps}).estimatedTotalUsd, expected);
}
const multipart = new FormData(); multipart.set('steps', '25');
close(imageCost({provider: 'workers-ai', model: '@cf/black-forest-labs/flux-2-dev', payload: multipart}, {size: '1456x1024'}).estimatedTotalUsd, 0.05865234375);
for (const model of ['@cf/stabilityai/stable-diffusion-xl-base-1.0', '@cf/bytedance/stable-diffusion-xl-lightning']) {
  const free = imageCost(request(model, 'workers-ai'), {size: '1456x1024'});
  assert.equal(free.estimatedTotalUsd, 0);
  assert.equal(free.costEvidence, 'published_zero_rate');
}
const dreamRequest = {provider: 'workers-ai', model: '@cf/lykon/dreamshaper-8-lcm', payload: {num_steps: 8}};
const dream = imageCost(dreamRequest, {size: '1456x1024'});
close(dream.estimatedTotalUsd, 0.000002728);
assert.equal(dream.costStatus, 'estimated');
assert.equal(dream.costEvidence, 'observed_neuron_usage');
assert.match(dream.estimateBasis, /four successful unsampled/);
for (const size of ['1024x1456', '1024x1024', '2912x1024']) {
  assert.equal(imageCost(dreamRequest, {size}).estimatedTotalUsd, null, 'Do not extrapolate a rate from one measured preset.');
}
for (const steps of [undefined, 0, 4, 9, '8oops']) {
  assert.equal(imageCost({...dreamRequest, payload: {num_steps: steps}}, {size: '1456x1024'}).estimatedTotalUsd, null);
}
close(imageCost({provider: dreamRequest.provider, model: dreamRequest.model}, {size: '1456x1024', inferenceSteps: 8}).estimatedTotalUsd, 0.000002728);
const oldDream = {provider: dreamRequest.provider, upstreamModel: dreamRequest.model, size: '1456x1024', estimatedTotalUsd: null, costStatus: 'unavailable', ratesChecked: '2026-10-23'};
const savedDream = refreshImageCostMetrics(oldDream);
close(savedDream.estimatedTotalUsd, 0.000002728);
assert.match(savedDream.estimateBasis, /assumes.*8-step/);
assert.equal(oldDream.estimatedTotalUsd, null);
const old = {provider: 'workers-ai', upstreamModel: '@cf/leonardo/phoenix-1.0', requestedModel: 'alias', size: '1456x1024', estimatedTotalUsd: null};
const refreshed = refreshImageCostMetrics(old);
close(refreshed.estimatedTotalUsd, 0.0429);
assert.equal(refreshed.costEvidence, 'observed_neuron_usage');
assert.match(refreshed.estimateBasis, /assumes.*25-step/);
assert.equal(old.estimatedTotalUsd, null, 'Read enrichment must not mutate historical storage.');
close(refreshImageCostMetrics({...old, estimatedTotalUsd: 0.04879875, ratesChecked: '2026-10-23'}).estimatedTotalUsd, 0.0429);
assert.equal(refreshImageCostMetrics(refreshed), refreshed, 'Current estimate versions need no refresh.');
const phoenix = {provider: 'workers-ai', model: old.upstreamModel, payload: {num_steps: 25}};
close(imageCost(phoenix, {size: '1456x1024'}).estimatedTotalUsd, 0.0429);
const unmeasuredPhoenix = imageCost(phoenix, {size: '1024x1024'});
close(unmeasuredPhoenix.estimatedTotalUsd, 4 * 780 * 0.011 / 1000);
assert.equal(unmeasuredPhoenix.costEvidence, 'metering_inferred_tile_rule');
for (const [size, expected] of [['1216x1712', 0.06006], ['1024x768', 0.02574], ['768x1024', 0.02574]]) {
  const cost = imageCost(phoenix, {size});
  close(cost.estimatedTotalUsd, expected);
  assert.match(cost.estimateBasis, /inferred.*flooring/);
}
const oldOpenAI = {provider: 'openai', upstreamModel: 'gpt-image-2', inputTokens: 100, outputTokens: 200, estimatedTotalUsd: 0.00325, ratesChecked: '2026-09-23'};
close(refreshImageCostMetrics(oldOpenAI).estimatedTotalUsd, 0.0065);
const reported = {...old, costStatus: 'reported', estimatedTotalUsd: 0.07};
assert.equal(refreshImageCostMetrics(reported), reported, 'A receipt must never be recalculated.');
const oldFal = {provider: 'fal', upstreamModel: 'fal-ai/lora', estimatedTotalUsd: 0.01};
assert.equal(refreshImageCostMetrics(oldFal), oldFal);
assert.equal(refreshImageCostMetrics({provider: 'workers-ai', upstreamModel: '@cf/unknown', size: '1456x1024'}).estimatedTotalUsd, null);
assert.equal(refreshImageCostMetrics({provider: 'openai', upstreamModel: 'gpt-image-2', outputTokens: 200}).estimatedTotalUsd, null);
console.log('PASS: model billing examples, step/area scaling, verified zero prices, scoped DreamShaper/Phoenix meter evidence, and safe saved-job enrichment.');

// Golden provider metering examples cover every native image model and all
// observed pixel-area variants. Accept only the meter's tiny float error.
const metering = JSON.parse(readFileSync(new URL('./fixtures/cloudflare-image-metering-20261023.json', import.meta.url)));
for (const row of metering.cases) {
  const cost = imageCost({provider: 'workers-ai', model: row.model, payload: {num_steps: row.steps}}, {size: row.size});
  assert.ok(Math.abs(cost.estimatedTotalUsd - row.meteredNeurons * 0.011 / 1000) < 1e-10,
    `${row.model} at ${row.size} disagrees with recorded Cloudflare metering`);
}
console.log('PASS: all nine Cloudflare image models reconcile against captured unsampled neuron records.');

// fal uses provider billing evidence, never elapsed time or a different model's rate.
const fal = {provider: 'fal', model: 'fal-ai/lora'};
const falEstimate = imageCost(fal, {billableUnits: 12.5, unitPriceUsd: 0.001, billingUnit: 'compute second', costCheckedAt: '2026-09-24T12:00:00Z'});
close(falEstimate.estimatedTotalUsd, 0.0125); assert.equal(falEstimate.costStatus, 'estimated');
assert.equal(falEstimate.ratesChecked, '2026-09-24');
const falReported = imageCost(fal, {reportedCostUsd: 0.009, billableUnits: 12.5, unitPriceUsd: 0.001});
close(falReported.estimatedTotalUsd, 0.009); assert.equal(falReported.costStatus, 'reported');
assert.equal(imageCost(fal, {reportedCostUsd: 0}).estimatedTotalUsd, 0);
for (const missing of [{inferenceMs: 12000, elapsedMs: 28000}, {billableUnits: null, unitPriceUsd: 0.001},
  {billableUnits: 12.5, unitPriceUsd: '0.001'}, {billableUnits: -1, unitPriceUsd: 0.001},
  {billableUnits: 12.5, unitPriceUsd: Infinity}, {billableUnits: 12.5, unitPriceUsd: 0.001}]) {
  assert.equal(imageCost(fal, missing).estimatedTotalUsd, null);
}

const proxy = imageCost(fal, {inferenceMs: 11765, unitPriceUsd: 0.00125, billingUnit: 'compute seconds'});
close(proxy.estimatedTotalUsd, 0.01470625); assert.equal(proxy.costEvidence, 'inference_time_proxy');
assert.match(proxy.estimateBasis, /overhead may increase/);
assert.equal(imageCost(fal, {elapsedMs: 28519, unitPriceUsd: 0.00125, billingUnit: 'compute seconds'}).estimatedTotalUsd, null);
assert.equal(imageCost(fal, {inferenceMs: 11765, unitPriceUsd: 0.025, billingUnit: 'image'}).estimatedTotalUsd, null);
