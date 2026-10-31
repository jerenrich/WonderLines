import assert from 'node:assert/strict';
import {catalog,liveCatalog} from '../src/catalog.mjs';
import {readFile} from 'node:fs/promises';
import {modelCostSummary} from '../public/cost-display.mjs';
import {modelReferenceCost} from '../src/model-reference-cost.mjs';

const models=catalog({});
const expected={
  'gpt-image-2.5-flare':'¢0.52', 'gpt-image-2.5-sunburst':'¢0.52',
  'flux-2-klein-4b':'¢0.16', 'flux-2-klein-9b':'¢1.58', 'flux-2-dev':'¢5.87',
  'flux-1-schnell':'¢0.19', 'lucid-origin':'¢5.86', 'phoenix-1.0':'¢4.29',
  'stable-diffusion-xl-base-1.0':'¢0.00', 'stable-diffusion-xl-lightning':'¢0.00', 'dreamshaper-8-lcm':'<¢0.01'
};
assert.equal(models.length,24);
assert.equal(modelReferenceCost({provider:"fal",model:"z-image-turbo"}).usd,0.01);
for(const model of models) {
  if(!Object.hasOwn(expected,model.id)){
    // New comparison presets have different endpoints or dimensions from the
    // audited app preset. Never invent prices or reuse its billing receipt.
    assert.equal(model.referenceCost,null);
    assert.equal(modelCostSummary(model),'Price unavailable · Estimate');
    continue;
  }
  const billing=false;
  assert.equal(modelCostSummary(model),`${expected[model.id]} / image · ${billing?'Billing confirmed':'Estimate'}`);
  assert.equal(model.referenceCost.billingConfirmed,billing);
  assert.equal(model.referenceCost.checkedOn,'2026-10-23');
  assert.ok(model.referenceCost.basis);
}
const remapped=catalog({IMAGE_MODEL_ROUTES:JSON.stringify({'gpt-image-2.5-flare':{provider:'workers-ai',model:'@cf/black-forest-labs/flux-2-klein-4b'}})});
assert.equal(modelCostSummary(remapped.find(m=>m.id==='gpt-image-2.5-flare')),'¢0.16 / image · Estimate');
const unknown=catalog({IMAGE_MODEL_ROUTES:JSON.stringify({'z-image-turbo':{provider:'openai',model:'unknown'}})});
assert.equal(unknown.find(m=>m.id==='z-image-turbo').referenceCost,null);
console.log('PASS: every model reference price, billing/estimate labels, preset rounding and upstream route changes.');

// The picker follows the same active routes as admission, including new models
// and comparison-only presets, and fails closed if KV is unavailable.
const document=JSON.parse(await readFile(new URL('../../coloring-sheets-api/model-registry.initial.json',import.meta.url)));
document.models.find(m=>m.id==='gpt-image-2.5-flare').enabled=false;
document.models.push({id:'test-dynamic',provider:'openai',model:'gpt-image-2.5-flare',enabled:true,visible:true,label:'Dynamic model',detail:'Test model',price:null});
let raw=JSON.stringify(document);
const liveEnv={MODEL_REGISTRY:{get:async()=>raw}};
let live=await liveCatalog(liveEnv);
assert.ok(!live.some(m=>m.id==='gpt-image-2.5-flare'));
assert.equal(live.find(m=>m.id==='test-dynamic').label,'Dynamic model');
assert.ok(live.some(m=>m.id==='sana-sprint'));
document.providers.fal.enabled=false;raw=JSON.stringify(document);
live=await liveCatalog(liveEnv);assert.ok(!live.some(m=>m.provider==='fal'));
raw='invalid';await assert.rejects(liveCatalog(liveEnv));
console.log('PASS: comparison picker uses KV availability, dynamic routes, provider switches and fail-closed handling.');
