// Cloudflare Worker: parent-operated coloring sheet prototype.
// Required secrets: OPENAI_API_KEY and APP_PASSWORD (use a long random password).
// Deployment: use the adjacent Wrangler config, or paste this file into the dashboard editor.
// Enable Workers Logs in Cloudflare to retain the structured generation events.
// API contract for the iPad client:
//   POST /generate: JSON {subject, model?, width?, height?}; dimensions are pixels.
//   Authorization: Bearer <APP_PASSWORD>. Omit BOTH dimensions for the A4 default.
//   Success: image/png plus URI-encoded JSON in X-Generation-Metrics.
//   Failure: plain text with a non-2xx status; do not automatically retry paid requests.
// Browser login uses /login, /session and /logout on the same origin instead.
// Before wider distribution: add rate limits, a durable generation quota, and
// per-device credentials. Never embed APP_PASSWORD or OPENAI_API_KEY in app source.
const MODEL = 'gpt-image-2.5-flare';
const ALLOWED_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const DEFAULT_WIDTH = 1024, DEFAULT_HEIGHT = 1456; // A4 portrait, rounded to 16px.
// Deliberately stay below experimental resolutions and bound Worker buffering.
// https://developers.openai.com/api/docs/guides/image-generation#size-and-quality-options
const MIN_PIXELS = 655360, MAX_PIXELS = 3686400, MAX_EDGE = 3840;
function imageDimensions(input) {
  const width = input?.width, height = input?.height;
  if (width === undefined && height === undefined) return {width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE ||
      width % 16 !== 0 || height % 16 !== 0 ||
      width / height < 1 / 3 || width / height > 3 ||
      width * height < MIN_PIXELS || width * height > MAX_PIXELS) return null;
  return {width, height};
}
const QUALITY = 'low';
// Standard synchronous API rates, USD per million tokens, checked 2026-09-19.
// https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
// Update this table if changing models or if OpenAI changes prices.
// Both allowed models currently share these rates. Adding a model with different
// rates requires a per-model pricing table and matching selector/validation changes.
const RATES = {textInput: 5, imageInput: 8, imageOutput: 30};
const COOKIE = '__Host-coloring_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
async function sessionKey(password) {
  // The shared password also signs sessions: use a password-manager-generated secret.
  // Rotating APP_PASSWORD invalidates all sessions. A readable signed token would
  // let its holder test guesses offline if the password were weak.
  return crypto.subtle.importKey('raw', encoder.encode(password), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
function hex(bytes) { return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join(''); }
async function makeSession(password, seconds) {
  // Stateless token: expiration + random identifier + HMAC; contains no password.
  // No revocation database exists. A copied token works until expiry/password rotation.
  const payload = Math.floor(Date.now() / 1000) + seconds + '.' + crypto.randomUUID();
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(password), encoder.encode('coloring-session-v1:' + payload));
  return payload + '.' + hex(signature);
}
async function hasSession(request, password) {
  if (!password) return false;
  const token = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[0-9a-f-]{36}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;
  const expires = Number(parts[0]), now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + SESSION_SECONDS) return false;
  const signature = Uint8Array.from(parts[2].match(/../g), x => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', await sessionKey(password), signature, encoder.encode('coloring-session-v1:' + parts[0] + '.' + parts[1]));
}
function cookie(value, maxAge) {
  // __Host- requires HTTPS, Path=/, and no Domain. HttpOnly blocks page JS access.
  // Without Max-Age the cookie is session-scoped; its signed token still expires in 1 day.
  return COOKIE + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Strict' + (maxAge == null ? '' : '; Max-Age=' + maxAge);
}

function generationMetrics(data, requestId, elapsedMs, model, size) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usage = data.usage;
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  const textInput = count(usage?.input_tokens_details?.text_tokens);
  const imageInput = count(usage?.input_tokens_details?.image_tokens);
  const outputDetails = usage?.output_tokens_details;
  // For the current image-only models, an absent output breakdown means image output.
  // Preserve null for missing usage; never turn an unknown charge into a zero estimate.
  const imageOutput = outputDetails ? count(outputDetails.image_tokens) : output;
  // Do not silently price an unfamiliar or incomplete usage schema.
  const canPrice = ALLOWED_MODELS.includes(model) && (!data.model || data.model === model) &&
    input !== null && output !== null && textInput !== null && imageInput !== null &&
    textInput + imageInput === input && imageOutput !== null &&
    (!outputDetails || (count(outputDetails.text_tokens) === 0 && imageOutput === output));
  const inputCost = canPrice ? (textInput * RATES.textInput + imageInput * RATES.imageInput) / 1e6 : null;
  const outputCost = canPrice ? imageOutput * RATES.imageOutput / 1e6 : null;
  return {
    requestedModel: model,
    requestedSize: size, size: data.size ?? size, quality: data.quality ?? QUALITY,
    inputTokens: input, textInputTokens: textInput, imageInputTokens: imageInput,
    outputTokens: output, totalTokens: count(usage?.total_tokens),
    estimatedInputUsd: inputCost, estimatedOutputUsd: outputCost,
    estimatedTotalUsd: canPrice ? inputCost + outputCost : null,
    ratesUsdPerMillion: RATES, ratesChecked: '2026-09-19',
    estimateBasis: 'Standard uncached rates; excludes cache discounts, other discounts, taxes, and Cloudflare charges. Not a billing receipt.',
    requestId, elapsedMs,
    usage: usage ?? null,
  };
}

function logGeneration(metrics) {
  // Intentionally excludes the child's prompt, password, image, API key, and response body.
  // Keep an explicit field allowlist; do not spread metrics or the upstream response here.
  // Success telemetry only: sampled/expired logs and billed requests whose responses
  // were lost mean this is not a complete cost ledger. Reconcile with OpenAI billing.
  console.log({
    event: 'coloring_sheet_generated',
    model: metrics.requestedModel,
    requested_size: metrics.requestedSize,
    input_tokens: metrics.inputTokens,
    output_tokens: metrics.outputTokens,
    total_tokens: metrics.totalTokens,
    estimated_cost_usd: metrics.estimatedTotalUsd,
    duration_ms: metrics.elapsedMs,
    openai_request_id: metrics.requestId,
  });
}

// Self-contained page for dashboard deployment. Keep user/API text out of this template;
// render dynamic values using textContent. Split HTML/CSS/JS when moving to a repository.
const PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coloring sheets</title>
<style>
body{font:18px system-ui;max-width:650px;margin:40px auto;padding:20px;color:#243044;background:#faf8f3}
label{display:block;margin:20px 0}input,textarea,button,select{font:inherit;box-sizing:border-box;padding:12px;width:100%}
textarea{height:110px}button{cursor:pointer}img{width:100%;margin-top:20px}a{display:block;margin-top:16px}[hidden]{display:none!important}
section{background:white;padding:20px;margin-top:24px;border:1px solid #ddd;border-radius:12px}table{width:100%;border-collapse:collapse;font-size:16px}th,td{text-align:left;padding:8px;border-bottom:1px solid #eee;overflow-wrap:anywhere}th{font-weight:500}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.note{font-size:14px;color:#526075}
input[type=checkbox]{width:auto;margin-right:8px}#logout{width:auto;padding:6px 12px;margin-left:10px}
</style>
<h1>Make a coloring sheet</h1><p>A little imagination, ready for crayons.</p>
<form id="form">
<div id="signIn">
<label>Your app password<input id="password" type="password" required autocomplete="current-password"></label>
<label><input id="remember" type="checkbox" checked>Remember me on this device for 30 days</label>
</div>
<p id="signedIn" hidden>Signed in on this device.<button id="logout" type="button">Forget this device</button></p>
<label>What shall we draw?<textarea id="subject" required maxlength="500">A friendly dinosaur riding a bicycle</textarea></label>
<label>Image model<select id="model">
<option value="gpt-image-2.5-flare" selected>GPT Image 2.5 Flare — faster</option>
<option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst — most capable</option>
</select></label>
<p class="note">Both models use the same token rates. The cost per image can differ depending on token usage.</p>
<button id="generate">Generate coloring sheet</button>
<p>Each generation uses paid OpenAI API credit. Please review the picture before sharing it with your child.</p>
</form>
<p id="status" role="status"></p><img id="picture" alt="Generated coloring sheet" hidden>
<a id="download" download="coloring-sheet.png" hidden>Download PNG</a>
<section id="metrics" hidden aria-label="Generation statistics">
<h2>This image’s usage</h2><table><tbody id="metricRows"></tbody></table>
<p class="note" id="costNote"></p>
<p class="note">Input includes your description and the coloring-page instructions. This app keeps no prompt or image history. Usage statistics are logged in Cloudflare.</p>
<details><summary>OpenAI usage details</summary><pre id="rawUsage"></pre></details>
<a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">Check actual OpenAI usage and charges</a>
</section>
<script>
const form=document.getElementById('form'), button=document.getElementById('generate');
const status=document.getElementById('status'), picture=document.getElementById('picture'), download=document.getElementById('download');
let imageURL;
const metrics=document.getElementById('metrics');
let signedIn=false;
const password=document.getElementById('password'), logout=document.getElementById('logout');
function setSignedIn(value){
  signedIn=value;document.getElementById('signIn').hidden=value;document.getElementById('signedIn').hidden=!value;
  password.required=!value;if(value)password.value='';
}
const sessionReady=fetch('/session',{credentials:'same-origin'}).then(r=>r.json()).then(data=>setSignedIn(data.signedIn)).catch(()=>setSignedIn(false));
logout.addEventListener('click',async()=>{
  logout.disabled=true;
  try{const response=await fetch('/logout',{method:'POST',credentials:'same-origin'});if(!response.ok)throw new Error('Could not sign out.');setSignedIn(false);password.value='';status.textContent='This device has been signed out.';}
  catch(error){status.textContent=error.message;}
  finally{logout.disabled=false;}
});
function showMetrics(m){
  const number=value=>value==null?'Not returned':value.toLocaleString();
  const dollars=value=>value==null?'Unavailable':'$'+value.toFixed(6)+' USD';
  const rows=[
    ['Model sent to OpenAI',m.requestedModel],
    ['Size / quality',m.size+' / '+m.quality],
    ['Input tokens',number(m.inputTokens)],['Input: text tokens',number(m.textInputTokens)],
    ['Input: image tokens',number(m.imageInputTokens)],['Output tokens',number(m.outputTokens)],
    ['Total tokens',number(m.totalTokens)],['Estimated input cost',dollars(m.estimatedInputUsd)],
    ['Estimated output cost',dollars(m.estimatedOutputUsd)],['Estimated total cost',dollars(m.estimatedTotalUsd)],
    ['Generation time',(m.elapsedMs/1000).toFixed(1)+' seconds'],['Request ID',m.requestId??'Not returned']
  ];
  const tbody=document.getElementById('metricRows');tbody.replaceChildren();
  for(const [label,value] of rows){const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');th.scope='row';th.textContent=label;td.textContent=value;tr.append(th,td);tbody.append(tr);}
  document.getElementById('costNote').textContent=m.estimateBasis+' Rates checked '+m.ratesChecked+': $'+m.ratesUsdPerMillion.textInput+'/million text input, $'+m.ratesUsdPerMillion.imageInput+'/million image input, $'+m.ratesUsdPerMillion.imageOutput+'/million image output tokens.';
  document.getElementById('rawUsage').textContent=JSON.stringify(m.usage,null,2);
  metrics.hidden=false;
}
form.addEventListener('submit',async event=>{
  event.preventDefault(); if(button.disabled)return;
  // This prevents repeated clicks in one tab, not concurrent requests from other clients.
  button.disabled=true; status.textContent='Drawing your sheet… This can take a couple of minutes.';
  picture.hidden=true;download.hidden=true;metrics.hidden=true;
  try {
    await sessionReady;
    logout.disabled=true;
    if(!signedIn){
      const login=await fetch('/login',{method:'POST',credentials:'same-origin',headers:{'Authorization':'Bearer '+password.value,'X-Remember-Me':document.getElementById('remember').checked?'yes':'no'}});
      if(!login.ok)throw new Error(await login.text());
      setSignedIn(true);
    }
    const response=await fetch('/generate',{
      method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subject:document.getElementById('subject').value,model:document.getElementById('model').value})
    });
    if(response.status===401)setSignedIn(false);
    if(!response.ok)throw new Error(await response.text());
    const blob=await response.blob();
    if(imageURL)URL.revokeObjectURL(imageURL);
    imageURL=URL.createObjectURL(blob);picture.src=imageURL;download.href=imageURL;
    picture.hidden=false;download.hidden=false;status.textContent='Ready! Download the picture to save or print it.';
    // Metrics must never prevent an otherwise successful image from displaying.
    try{const value=response.headers.get('X-Generation-Metrics');if(value)showMetrics(JSON.parse(decodeURIComponent(value)));}catch{status.textContent+=' Usage statistics could not be displayed.';}
  }catch(error){status.textContent=error.message+' No automatic retry was made.';}
  finally{button.disabled=false;logout.disabled=false;}
});
</script></html>`;

function reply(body, status = 200, type = 'text/plain; charset=utf-8') {
  // no-store covers images, session checks, metrics and errors.
  // Inline scripts/styles keep this single-file prototype portable. When extracting
  // the frontend, replace unsafe-inline with script hashes/nonces or external assets.
  return new Response(body, {status, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  }});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return reply(PAGE, 200, 'text/html; charset=utf-8');
    if (url.pathname === '/session' && request.method === 'GET') return reply(JSON.stringify({signedIn: await hasSession(request, env.APP_PASSWORD)}), 200, 'application/json');
    const origin = request.headers.get('Origin');
    // TODO before wider use: throttle login attempts independently of image generation.
    if (url.pathname === '/login' || url.pathname === '/logout') {
      if (request.method !== 'POST') return reply('Use POST', 405);
      if (origin !== url.origin) return reply('Origin not allowed.', 403);
      if (url.pathname === '/logout') {
        // Browser-local logout only; server-side per-device revocation needs stored sessions.
        const response = reply('Signed out.');response.headers.set('Set-Cookie', cookie('', 0));return response;
      }
      if (!env.APP_PASSWORD) return reply('Configure APP_PASSWORD in Cloudflare.', 503);
      if (request.headers.get('Authorization') !== 'Bearer ' + env.APP_PASSWORD) return reply('Incorrect app password.', 401);
      const remember = request.headers.get('X-Remember-Me') === 'yes';
      const response = reply('Signed in.');
      response.headers.set('Set-Cookie', cookie(await makeSession(env.APP_PASSWORD, remember ? SESSION_SECONDS : 86400), remember ? SESSION_SECONDS : null));
      return response;
    }
    if (url.pathname !== '/generate') return reply('Not found', 404);
    if (request.method !== 'POST') return reply('Use POST', 405);
    if (!env.OPENAI_API_KEY || !env.APP_PASSWORD) return reply('Add both OPENAI_API_KEY and APP_PASSWORD secrets in Cloudflare, then deploy.', 503);
    const bearerAuth = request.headers.get('Authorization') === 'Bearer ' + env.APP_PASSWORD;
    if (!bearerAuth && !await hasSession(request, env.APP_PASSWORD)) return reply('Please enter your app password to sign in again.', 401);
    // Cookie-authenticated writes must originate from this page (CSRF protection).
    if (!bearerAuth && origin !== url.origin) return reply('Origin not allowed.', 403);
    if (origin && origin !== url.origin) return reply('Origin not allowed.', 403);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply('Send JSON.', 415);
    // Limit the body while reading, even when Content-Length is omitted.
    let body = '';
    if (!request.body) return reply('Missing request body.', 400);
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return reply('Request too large.', 413); }
      body += decoder.decode(value, {stream: true});
    }
    body += decoder.decode();
    let subject, model, dimensions;
    try {
      const input = JSON.parse(body);
      subject = input?.subject; model = input?.model === undefined ? MODEL : input.model;
      dimensions = imageDimensions(input);
    } catch { return reply('Invalid JSON.', 400); }
    if (!ALLOWED_MODELS.includes(model)) return reply('Choose GPT Image 2.5 Flare or Sunburst.', 400);
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 500) return reply('Enter a description of 1–500 characters.', 400);
    if (!dimensions) return reply('Send both width and height as positive integer pixels, multiples of 16, at most 3840 per edge, with aspect ratio 1:3–3:1 and 655360–3686400 total pixels.', 400);
    const size = dimensions.width + 'x' + dimensions.height;
    // TODO: reserve a generation allowance atomically before the paid call. An in-memory
    // counter is insufficient across Worker instances. Use durable shared state for a
    // strict daily quota; burst rate limiting alone is not an exact spending cap.
    try {
      const started = Date.now();
      const result = await fetch('https://api.openai.com/v1/images/generations', {
        // Intentionally no retries. A timeout/disconnection does not prove OpenAI stopped
        // generating or billing. Future retry support needs persisted job/deduplication state.
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          model, n: 1, size, quality: QUALITY, output_format: 'png',
          // Clients can include plain-language complexity guidance in subject; no age field
          // is needed. Keep these base instructions age-neutral so that guidance can vary.
          prompt: 'Create a printable coloring page with bold clean black outlines on a pure white background, enclosed areas to color, and generous white margins. Follow any complexity guidance in the subject description when choosing the amount of detail, number of objects, and size of coloring areas. If no complexity guidance is provided, use moderately simple shapes and detail. No shading, gray, colors, text, or watermarks. Friendly, gentle, child-appropriate imagery only. Subject and complexity guidance: ' + subject.trim(),
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!result.ok) {
        // Keep upstream details and credentials out of responses and logs.
        const error = await result.json().catch(() => ({}));
        let message = 'OpenAI could not generate this image. Try a simpler description.';
        if (result.status === 401) message = 'OpenAI rejected the API key. Check OPENAI_API_KEY.';
        else if (result.status === 403) message = 'OpenAI denied model access. Check model access and any organization verification requirement in your OpenAI dashboard.';
        else if (error.error?.code === 'insufficient_quota') message = 'OpenAI reports insufficient credit or quota. Check your API billing balance.';
        else if (result.status === 429) message = 'OpenAI reports a rate or quota limit. Check API billing and limits before trying again.';
        else if (result.status >= 500) message = 'OpenAI is temporarily unavailable.';
        return reply(message + ' (OpenAI status ' + result.status + ')', 502);
      }
      const data = await result.json();
      const encoded = data.data?.[0]?.b64_json;
      if (!encoded) return reply('OpenAI returned no image.', 502);
      const response = reply(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), 200, 'image/png');
      // This buffers the full response and decoded PNG. Re-check memory/CPU use before
      // increasing resolution or requesting multiple images; large jobs may need storage.
      // Keep the PNG response compatible with existing clients; attach usage metadata.
      const metrics = generationMetrics(data, result.headers.get('x-request-id'), Date.now() - started, model, size);
      logGeneration(metrics);
      response.headers.set('X-Generation-Metrics', encodeURIComponent(JSON.stringify(metrics)));
      return response;
    } catch {
      // This catch also includes response parsing/decoding failures. Future error telemetry
      // should use fixed categories + request ID, never raw upstream bodies or exception text.
      return reply('The request timed out or the connection failed. Check OpenAI usage before retrying; generation may still have been charged.', 504);
    }
  },
};
