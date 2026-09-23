import assert from 'node:assert/strict';
import {imageCost} from '../workers/coloring-sheets-api/src/image-cost.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const request = (model, provider = 'openai') => ({model, provider, payload: {prompt: 'A friendly flower'}});
for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  const cost = imageCost(request(model), {inputTokens: 100, textInputTokens: 80, imageInputTokens: 20, outputTokens: 200});
  close(cost.estimatedInputUsd, 0.00056);
  close(cost.estimatedOutputUsd, 0.006);
  close(cost.estimatedTotalUsd, 0.00656);
  assert.equal(cost.ratesChecked, '2026-09-23');
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
close(imageCost(request('gpt-image-2'), {inputTokens: 100, outputTokens: 200}).estimatedTotalUsd, 0.00325);
// Never apply a picker's OpenAI rates to a remapped/unknown upstream model or provider.
for (const route of [request('another-image-model'), request('gpt-image-2.5-flare', 'google-ai-studio'),
  request('gemini-2.5-flash-image', 'google-ai-studio'), request('@cf/unknown', 'workers-ai')]) {
  assert.equal(imageCost(route, {inputTokens: 100, outputTokens: 200, size: '1024x1024'}).estimatedTotalUsd, null);
}
for (const [size, cost4B, cost9B] of [
  ['1024x1024', 0.001148, 0.015],
  ['1024x1456', 0.0016323125, 0.01584375],
  ['1456x1024', 0.0016323125, 0.01584375],
  ['1920x1328', 0.0027915234375, 0.01786328125],
  ['512x512', 0.000287, 0.015]
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
