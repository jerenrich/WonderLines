import assert from 'node:assert/strict';
import {formatCents, formatPriceText, displayMetric, exportComparison, modelCostSummary, matchingReferenceModel} from '../public/cost-display.mjs';

for (const [usd, expected] of [[0, '¢0.00'], [0.001, '¢0.10'], [0.0065, '¢0.65'],
  [0.0429, '¢4.29'], [0.000002728, '<¢0.01'], [12.5, '¢1,250.00'], [1e-15, '<¢0.01']]) {
  assert.equal(formatCents(usd), expected);
}
for (const invalid of [null, undefined, '0.001', -1, NaN, Infinity]) assert.equal(formatCents(invalid), 'Unavailable');
assert.equal(formatPriceText('12.5 units × $0.00125 per second; $0.015625 USD total.'),
  '12.5 units × ¢0.13 per second; ¢1.56 total.');
assert.equal(formatPriceText('0.248 × $0.011 / 1,000 neurons; $0.000002728 each.'),
  '0.248 × ¢1.10 / 1,000 neurons; <¢0.01 each.');
assert.equal(formatPriceText('No billing receipt; 25 steps.'), 'No billing receipt; 25 steps.');
assert.deepEqual(displayMetric('estimatedTotalUsd', 0.001), ['Estimated total cost (US cents)', '¢0.10']);
assert.deepEqual(displayMetric('reportedCostUsd', 0), ['Reported cost (US cents)', '¢0.00']);
assert.deepEqual(displayMetric('unitPriceUsd', null), ['Unit price (US cents)', null]);
assert.deepEqual(displayMetric('inputTokens', 100), ['inputTokens', 100]);
const grid = {prompt: 'A shop with a $1 sign', cells: [{id: 'saved', metrics: {estimatedTotalUsd: 0.001,
  reportedCostUsd: 0, unitPriceUsd: 0.005, estimatedInputUsd: null, estimateBasis: '$0.005 per megapixel', billableUnits: 2}}, {id: 'waiting'}]};
const before = structuredClone(grid), exported = exportComparison(grid);
assert.equal(exported.priceUnit, 'US cents');
assert.deepEqual(exported.cells[0].metrics, {estimatedTotalCents: 0.1, reportedCostCents: 0, unitPriceCents: 0.5,
  estimatedInputCents: null, estimateBasis: '¢0.50 per megapixel', billableUnits: 2});
assert.equal(exported.prompt, grid.prompt, 'Do not rewrite dollar signs in user content.');
assert.deepEqual(grid, before, 'Presentation/export must not change provider or stored USD metrics.');
assert.equal(formatCents(0.000099), '<¢0.01');
assert.equal(formatCents(0.0001), '¢0.01');
assert.equal(formatCents(0.005203125), '¢0.52');
assert.equal(modelCostSummary({referenceCost:{usd:0.01,billingConfirmed:true}}), '¢1.00 / image · Billing confirmed');
assert.equal(modelCostSummary({referenceCost:{usd:0.000002728,billingConfirmed:false}}), '<¢0.01 / image · Estimate');
assert.equal(modelCostSummary({referenceCost:null}), 'Price unavailable · Estimate');
const oldRoute={id:'alias',provider:'workers-ai',model:'@cf/old'};
const newRoute={id:'alias',provider:'openai',model:'gpt-image-2.5-flare',referenceCost:{usd:0.01}};
assert.equal(matchingReferenceModel(oldRoute,[newRoute]).referenceCost,null,'Do not label an old model with a remapped alias price.');
assert.equal(matchingReferenceModel(newRoute,[newRoute]),newRoute);
console.log('PASS: cents totals, tiny and zero costs, historical rates, detail labels, and correctly denominated exports.');
