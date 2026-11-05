import assert from 'node:assert/strict';
import {formatCents, formatPriceText, displayMetric, exportComparison, modelCostSummary, matchingReferenceModel} from '../public/cost-display.mjs';
import {modelTiming, requestTimeMs, formatDuration} from '../public/timing-display.mjs';

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

assert.equal(requestTimeMs({requestMs:0,elapsedMs:9000,queueMs:1000}),0);
assert.equal(requestTimeMs({elapsedMs:9000,queueMs:1000}),8000);
assert.equal(requestTimeMs({provider:'fal',inferenceMs:2000}),null,'Provider compute time is not end-to-end request time.');
assert.equal(requestTimeMs({provider:'openai',inferenceMs:2000}),2000);
for(const metrics of [null,{}, {elapsedMs:100,queueMs:200}, {elapsedMs:100,queueMs:-1}, {requestMs:NaN}, {requestMs:'100'}]) assert.equal(requestTimeMs(metrics),null);
const timings=modelTiming([
  {model:'test',status:'completed',metrics:{requestMs:2000,elapsedMs:5000}},
  {model:'test',status:'completed',metrics:{elapsedMs:7000,queueMs:3000}},
  {model:'test',status:'completed',metrics:{elapsedMs:9000}},
  {model:'test',status:'failed',metrics:{requestMs:90000,elapsedMs:90000}},
  {model:'other',status:'completed',metrics:{requestMs:90000,elapsedMs:90000}}
],'test');
assert.deepEqual(timings,{requestMs:3000,elapsedMs:7000,requestCount:2,totalCount:3});
assert.deepEqual(modelTiming([],'test'),{requestMs:null,elapsedMs:null,requestCount:0,totalCount:0});
assert.equal(formatDuration(null),'—');assert.equal(formatDuration(0),'0.0s');assert.equal(formatDuration(20500),'20.5s');
assert.deepEqual(displayMetric('requestMs',20500),['Request time','20.5s']);
assert.deepEqual(displayMetric('elapsedMs',23000),['Total time','23.0s']);
const presetGrid={models:[{id:'2.6-low',complexity:'low'}],cells:[{metrics:{requestMs:2000,elapsedMs:3000,complexity:'low'}}]};
assert.deepEqual(exportComparison(presetGrid).cells[0].metrics,presetGrid.cells[0].metrics);
assert.equal(exportComparison(presetGrid).models[0].complexity,'low');
console.log('PASS: request/total means, historical timing recovery, missing data, real zero durations, completed-image filtering and exported complexity.');

const queueStages={dispatchWaitMs:200,runnerHandoffMs:300,runnerAlarmWaitMs:100,runnerPreparationMs:20,safetyCheckMs:40};
for(const [key,label] of Object.entries({dispatchWaitMs:'account dispatch',runnerHandoffMs:'runner handoff',runnerAlarmWaitMs:'runner alarm wait',runnerPreparationMs:'runner preparation',safetyCheckMs:'safety check'})) {
  assert.deepEqual(displayMetric(key,queueStages[key]),['Queue: '+label,queueStages[key]+'ms']);
  assert.deepEqual(displayMetric(key,0),['Queue: '+label,'0ms']);
  for(const invalid of [-1,NaN,Infinity,null,'100'])assert.deepEqual(displayMetric(key,invalid),['Queue: '+label,null]);
}
assert.deepEqual(displayMetric('dispatchWaitMs',1234),['Queue: account dispatch','1.234s']);
assert.deepEqual(exportComparison({cells:[{metrics:queueStages}]}).cells[0].metrics,queueStages,'Stage durations keep their millisecond units in exports.');
console.log('PASS: queue stage labels, millisecond precision, invalid timing exclusion and exported stage timings.');
