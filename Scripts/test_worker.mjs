// Executes only the local Worker with a synthetic upstream. No network.
import assert from 'node:assert/strict';
import worker from '../workers/coloring-sheets-api/src/index.mjs';
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const messages = [];
let forwarded;
let calls = 0;
console.log = (...args) => messages.push(args);
globalThis.fetch = async (url, request) => {
  assert.equal(url, 'https://api.openai.com/v1/images/generations');
  calls++;
  forwarded = JSON.parse(request.body);
  return new Response(JSON.stringify({data: [{b64_json: 'iVBORw0KGgo='}], usage: null}), {headers: {'content-type':'application/json'}});
};
try {
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    for (const guidance of ['very simple outlines, a few large enclosed coloring areas', 'intricate outlines, smaller enclosed coloring areas']) {
      const subject = 'Synthetic flower. Complexity: ' + guidance;
      const response = await worker.fetch(new Request('https://example.test/generate', {
        method: 'POST', headers: {'Authorization':'Bearer dummy-family', 'Content-Type':'application/json'},
        body: JSON.stringify({subject, model})
      }), {APP_PASSWORD:'dummy-family', OPENAI_API_KEY:'dummy-upstream'});
      assert.equal(response.status, 200);
      assert.equal(forwarded.model, model);
      assert.ok(forwarded.prompt.endsWith(subject));
      assert.ok(forwarded.prompt.includes('Follow any complexity guidance'));
      assert.ok(!/six.year|6.year|age 6/i.test(forwarded.prompt));
      assert.equal(forwarded.n, 1);
      assert.equal(forwarded.size, '1024x1456');
      const metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
      assert.equal(metrics.requestedModel, model);
      assert.ok(!Object.hasOwn(metrics, 'returnedModel'));
      assert.equal(metrics.requestedSize, '1024x1456');
      assert.equal(metrics.size, '1024x1456');
    }
  }
  assert.equal(calls, 4);
  async function generate(dimensions, model = 'gpt-image-2.5-flare') {
    return worker.fetch(new Request('https://example.test/generate', {
      method: 'POST', headers: {'Authorization':'Bearer dummy-family', 'Content-Type':'application/json'},
      body: JSON.stringify({subject: 'Synthetic flower', model, ...dimensions})
    }), {APP_PASSWORD:'dummy-family', OPENAI_API_KEY:'dummy-upstream'});
  }
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    for (const [width, height] of [[992, 1408], [768, 1072], [1456, 1024], [1024, 1024], [640, 1024], [2560, 1440], [1536, 1024]]) {
      const response = await generate({width, height}, model);
      assert.equal(response.status, 200);
      assert.equal(forwarded.size, width + 'x' + height);
      const metrics = JSON.parse(decodeURIComponent(response.headers.get('X-Generation-Metrics')));
      assert.equal(metrics.requestedSize, forwarded.size);
      assert.equal(metrics.size, forwarded.size);
    }
  }
  const beforeInvalid = calls;
  for (const dimensions of [
    {width: 1024}, {height: 1456}, {width: null, height: null},
    {width: '1024', height: 1456}, {width: true, height: 1456},
    {width: 1024.5, height: 1456}, {width: 1023, height: 1456},
    {width: 0, height: 1456}, {width: -1024, height: 1456},
    {width: 16, height: 16}, {width: 4096, height: 1024},
    {width: 2048, height: 2048}, {width: 2048, height: 512}
  ]) {
    assert.equal((await generate(dimensions)).status, 400, JSON.stringify(dimensions));
  }
  assert.equal(calls, beforeInvalid, 'Invalid dimensions must never trigger a paid call');
  const page = await (await worker.fetch(new Request('https://example.test/'), {})).text();
  assert.ok(page.includes('Model sent to OpenAI'));
  assert.ok(!page.includes('Returned model'));
  assert.ok(!JSON.stringify(messages).includes('Synthetic flower'));
  assert.ok(!JSON.stringify(messages).includes('dummy-family'));
  assert.ok(!JSON.stringify(messages).includes('dummy-upstream'));
} finally { globalThis.fetch = originalFetch; console.log = originalLog; }
console.log('PASS: models, complexity, A4 defaults, custom dimensions, metrics, and pre-payment validation; no network.');
