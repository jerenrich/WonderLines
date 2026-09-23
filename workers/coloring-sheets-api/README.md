# coloring-sheets-api

Cloudflare Worker used by the iPhone and iPad app for anonymous, authenticated image generation. The Worker keeps provider credentials server-side and exposes `/v1` endpoints. It supports nine Cloudflare-hosted Workers AI image models plus OpenAI and Google Gemini image generation through Cloudflare AI Gateway, with direct OpenAI retained for existing deployments until Gateway is configured.

## Files

- `src/index.mjs` — dependency-free Worker entry point and Durable Object account ledger.
- `src/image-provider.mjs` — model allowlist, AI Gateway authentication, provider request adapters, and PNG/usage normalization.
- `wrangler.jsonc` — deployment identity, runtime compatibility date, Durable Object, and R2 bindings.

## Test locally

From the repository root:

```sh
node Scripts/test_worker.mjs
```

This replaces upstream requests with synthetic responses and makes no network calls or paid generations. It covers direct OpenAI, both Gateway credential modes, Gemini, all nine Workers AI models, model remapping, validation before spending, PNG output and metrics, provider failures, recovery, idempotency, renewal, and budgets.

## Configure and deploy

Authenticate Wrangler with the intended Cloudflare account, then deploy from this directory:

```sh
npx wrangler deploy --keep-vars
```

For a first deployment, create the `coloring-sheets-generations` R2 bucket and add `ACCOUNT_TOKEN_SECRET` plus the provider/Gateway secrets for your chosen configuration below. Direct OpenAI and Gateway with Worker-held OpenAI keys require `OPENAI_API_KEY`. On an existing deployment, preserve existing secrets during the migration. In particular, replacing `ACCOUNT_TOKEN_SECRET` invalidates every saved anonymous account credential and prevents renewal. The app contains no shared Worker password.

`GLOBAL_DAILY_GENERATION_LIMIT` is a dashboard-managed Worker variable, rather than a value in `wrangler.jsonc`. Set it to a whole number from `0` through `100000`; `0` pauses all generation. Change it in Cloudflare Dashboard → Workers & Pages → `coloring-sheets-api` → Settings → Variables and Secrets. The Worker fails closed if this setting is missing or malformed, and every dashboard change creates a new Worker version without requiring an app release or source-code edit. Use `--keep-vars` for source deployments so this dashboard value remains intact.

Deployment is intentionally manual. Review source changes and run the offline test before deploying because a Worker change affects both the app and browser clients.

`FREE_DAILY_ALLOWANCE` is configured as `1000` images per anonymous account per UTC day. Both access reporting and reservation enforcement accept whole-number allowances up to `100000`. Account reservations are serialized across the global budget call so simultaneous requests cannot reuse the same free allowance. The global daily limit remains an independent ceiling across all accounts.

## Enable AI Gateway using your current OpenAI credits

1. In Cloudflare Dashboard → AI → AI Gateway, create a gateway (for example, `coloring-sheets`). Enable Authenticated Gateway and create an authentication token with **AI Gateway Run** permission.
2. Add the Worker secret `AI_GATEWAY_TOKEN` using the dashboard or `npx wrangler secret put AI_GATEWAY_TOKEN`. Keep `OPENAI_API_KEY` as your existing OpenAI project key and preserve `ACCOUNT_TOKEN_SECRET`.
3. Add these **Worker variables** in the dashboard:

   | Variable | Value |
   | --- | --- |
   | `AI_GATEWAY_ACCOUNT_ID` | Your 32-character Cloudflare account ID |
   | `AI_GATEWAY_ID` | The gateway ID, e.g. `coloring-sheets` |
   | `AI_GATEWAY_KEY_SOURCE` | `worker` |

4. Run the offline tests, then deploy manually with `npx wrangler deploy --keep-vars` from this directory. Keep `GLOBAL_DAILY_GENERATION_LIMIT` configured as described above.

The existing model choices and OpenAI payload are preserved: one PNG, `quality: low`, and exact requested dimensions. Requests now go to `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/images/generations`. The Worker sends your OpenAI key in `Authorization` and the Gateway token in `cf-aig-authorization`. OpenAI remains the upstream billing account, so eligible credits on that account can still be used. See Cloudflare's [OpenAI provider integration](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/).

Gateway/model variables deliberately stay out of source-controlled `vars`; `--keep-vars` preserves dashboard experiments. Never put actual keys into Wrangler variables or committed files. For local Wrangler use, put the variables and secrets in an ignored `.dev.vars` file.

No Gateway settings means the existing direct OpenAI path. Any partial or invalid Gateway configuration returns HTTP 503 for new generations before reserving allowance. There is no automatic direct-provider fallback. To roll back to direct OpenAI, remove all four `AI_GATEWAY_*` settings, retain `OPENAI_API_KEY`, and restore OpenAI routes/defaults if changed.

If provisioning the Gateway through its management API, use a separate **Account → AI Gateway → Edit** token for setup. Edit also authorizes reading Gateway configuration; do not try adding duplicate Read/Edit/Run rows in the dashboard. The deployed Worker receives the **Run** token as `AI_GATEWAY_TOKEN`; FLUX additionally requires a distinct Workers AI credential as `WORKERS_AI_API_TOKEN`, created with Cloudflare’s Workers AI template. The setup token is not stored in the Worker.

## Store provider keys in Gateway instead

Add your OpenAI key under the gateway's **Provider Keys**, using the `default` alias, then set `AI_GATEWAY_KEY_SOURCE=gateway`. Keep `AI_GATEWAY_TOKEN`. The Worker now omits provider authorization headers, allowing Gateway to inject the stored key. A retained `OPENAI_API_KEY` Worker secret is ignored in this mode and may be removed after verifying the migration. This still uses your own OpenAI key; configure the stored key before switching modes. See [Cloudflare BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).

The key-source setting applies to OpenAI and Google routes. Native Workers AI routes use a Cloudflare token instead. In `worker` mode, OpenAI routes require `OPENAI_API_KEY` and Google routes require `GOOGLE_AI_STUDIO_API_KEY`. In `gateway` mode, configure each provider's key in Gateway. The Worker cannot inspect whether a stored key is valid or whether Gateway has Unified Billing enabled; those remain Gateway settings. Only `ACCOUNT_TOKEN_SECRET` is unconditionally required by Wrangler; conditional credentials are checked before a new generation reserves capacity.

## Experiment with models

`IMAGE_MODEL_ROUTES` is a dashboard-managed Worker **text variable containing JSON**. Entries add to or override the eleven built-in public IDs. Each entry must have exactly `provider` and `model`; supported adapters are `openai`, `google-ai-studio`, and `workers-ai`. The Workers AI adapter accepts the nine models listed below, using each model’s documented multipart or JSON input protocol. The allowlist has a maximum of 32 routes. The client cannot supply a provider, URL, API key, or provider options.

For example, to retain both OpenAI choices and add a Gemini image model, set:

```json
{
  "gemini-image": {
    "provider": "google-ai-studio",
    "model": "gemini-2.5-flash-image"
  }
}
```

Configure a Google provider key using the chosen key-source mode. Gemini requires Gateway; it never uses the OpenAI key. An authenticated API client can now send `model: "gemini-image"` to the existing generation endpoint. Model availability/access depends on the provider account. This adapter uses Google's `generateContent` API through Cloudflare's [Google AI Studio endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/).

`IMAGE_DEFAULT_MODEL` optionally selects the public ID used when a request omits `model`; otherwise it remains `gpt-image-2.5-flare`. `GET /v1/models` requires the existing account bearer token and returns `{defaultModel, models: [{id, provider, model}]}`. This lists configured routes, not a live provider availability check. Unknown IDs return HTTP 400 before allowance is spent; malformed server configuration returns HTTP 503.

The iOS picker offers Flare, Sunburst, and all nine Cloudflare-hosted models listed below after rebuilding the app, with a short description of each selection. It sends the selected explicit ID; changing the server default does not change those requests. Other custom catalog entries do not automatically appear in the picker. To experiment with another provider without an app release, temporarily override an existing ID:

```json
{
  "gpt-image-2.5-sunburst": {
    "provider": "google-ai-studio",
    "model": "gemini-2.5-flash-image"
  }
}
```

The app's existing picker label will remain Sunburst. The response metrics record both the public `requestedModel` and actual `upstreamModel`, plus `provider` and `viaGateway`. Other OpenAI image models can be configured the same way if they support the adapter's existing Images API payload (`size`, `quality: low`, `output_format: png`, base64 output). This is an image-generation API, not a generic chat-model proxy. Providers with different protocols need another adapter in `image-provider.mjs`.

Gemini accepts preset aspect ratios rather than arbitrary pixel dimensions. The adapter chooses the nearest supported ratio and leaves resolution at the model default. PNG bytes are preserved; no resizing or cropping occurs. `requestedSize` records the client request and `size` records the actual PNG dimensions for all providers. Gemini token usage is normalized into the existing metrics fields; absent usage remains null. Non-PNG responses fail explicitly. See Google's [image generation guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation).

## Cloudflare-hosted image models

All nine routes below are built in and appear in Settings → Model after rebuilding. The seven additions are FLUX.2 Dev, FLUX.1 Schnell, Lucid Origin, Phoenix 1.0, SDXL, SDXL Lightning, and DreamShaper. Each uses the same Cloudflare credentials; no separate Leonardo, Stability AI, or Black Forest Labs account/key is needed.

| Picker / public model ID | Workers AI model | Why try it for coloring sheets? |
| --- | --- | --- |
| FLUX.2 Klein 4B / `flux-2-klein-4b` | `@cf/black-forest-labs/flux-2-klein-4b` | Existing quick baseline. |
| FLUX.2 Klein 9B / `flux-2-klein-9b` | `@cf/black-forest-labs/flux-2-klein-9b` | Existing larger Klein alternative. |
| FLUX.2 Dev / `flux-2-dev` | `@cf/black-forest-labs/flux-2-dev` | Candidate for detailed scenes; expect longer generation. |
| FLUX.1 Schnell / `flux-1-schnell` | `@cf/black-forest-labs/flux-1-schnell` | Quick comparison with native, fixed output dimensions. |
| Lucid Origin / `lucid-origin` | `@cf/leonardo/lucid-origin` | First candidate for illustrations and precise style instructions. |
| Phoenix 1.0 / `phoenix-1.0` | `@cf/leonardo/phoenix-1.0` | First candidate for scenes needing strong prompt adherence. |
| Stable Diffusion XL (Beta) / `stable-diffusion-xl-base-1.0` | `@cf/stabilityai/stable-diffusion-xl-base-1.0` | Classic illustration baseline. |
| SDXL Lightning (Beta) / `stable-diffusion-xl-lightning` | `@cf/bytedance/stable-diffusion-xl-lightning` | Speed-focused SDXL comparison. |
| DreamShaper 8 LCM / `dreamshaper-8-lcm` | `@cf/lykon/dreamshaper-8-lcm` | Alternative style comparison for imaginative subjects. |

These are evaluation recommendations inferred from model capabilities, not measured coloring-page quality rankings. Cloudflare lists SDXL and Lightning as beta. Model schemas and availability were checked against Cloudflare’s documentation on 23 September 2026: [catalog](https://developers.cloudflare.com/workers-ai/models/), [FLUX.2 Dev](https://developers.cloudflare.com/workers-ai/models/flux-2-dev/), [Schnell](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/), [Lucid Origin](https://developers.cloudflare.com/workers-ai/models/lucid-origin/), [Phoenix](https://developers.cloudflare.com/workers-ai/models/phoenix-1.0/), [SDXL](https://developers.cloudflare.com/workers-ai/models/stable-diffusion-xl-base-1.0/), [Lightning](https://developers.cloudflare.com/workers-ai/models/stable-diffusion-xl-lightning/), and [DreamShaper](https://developers.cloudflare.com/workers-ai/models/dreamshaper-8-lcm/).

### Shared configuration

Wrangler declares an `IMAGES` binding for JPEG-to-PNG conversion. Set `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `AI_GATEWAY_TOKEN` as above. Create a **separate token** using Cloudflare’s **Workers AI** template (Workers AI Read and Edit), limited to the Worker's account, and save it as the `WORKERS_AI_API_TOKEN` secret. An installation already running Klein needs no additional provider credentials. The Worker sends the Workers AI token as `Authorization` and the Gateway Run token as `cf-aig-authorization`. Missing or identical credentials return HTTP 503 before allowance is reserved.

Requests use `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/{model}`, with cache skipping and one attempt. Multipart requests use this provider-native endpoint because `AI.run()` previously rejected multipart streams with gateway options. No `AI` binding or saved Wrangler OAuth token is required. See [Workers AI REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) and [Workers AI through Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/).

### Input and output differences

- FLUX.2 Klein and Dev use multipart `prompt`, `width`, and `height`, fitted within 1920 pixels per edge to the nearest 16 pixels. Klein uses fixed four-step inference; Dev explicitly uses 25 steps. See the [FLUX.2 multipart parameters](https://developers.cloudflare.com/changelog/post/2025-11-25-flux-2-dev-workers-ai/).
- Schnell uses JSON `prompt` and `steps: 4`. Its documented API has no dimensions fields, so the Worker does not send them. Native output is preserved and fits within the app’s page; it may leave more white space on A4.
- Lucid uses JSON dimensions fitted within 2496 pixels (the largest multiple of 16 under its 2500-pixel limit) and `num_steps: 25`.
- Phoenix uses JSON dimensions fitted within 2048 pixels and `num_steps: 25`. SDXL, Lightning, and DreamShaper use the same dimension limit with 20, 4, and 8 steps respectively. These four models also receive a negative prompt discouraging color, shading, photographs, text, and watermarks.

Every model receives the existing child-appropriate, black-outline coloring prompt and age guidance. JSON base64 images and binary PNG/JPEG responses are supported. JPEG is converted once through Images; PNG passes through after signature/dimension validation. Nothing is cropped or resized after inference. The resulting PNG is stored in R2 once; recovering it repeats neither inference nor conversion. Metrics retain the requested and actual dimensions and model IDs. Missing token counts remain null and no dollar estimate is invented.

Workers AI inference is billed by Cloudflare and does not spend OpenAI credits. Check [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) for current rates; the existing generation-count limits do not cap dollars. JPEG conversion also counts toward [Images transformations](https://developers.cloudflare.com/images/pricing/). Existing default and saved selections are preserved.

### Rollout and verification

Deploy the Worker with `npx wrangler deploy --keep-vars` before using the new choices in a rebuilt live app. The seven additions have offline protocol/recovery coverage; they have not yet been deployed or tested with paid live generations as part of this change. The earlier Klein live verification below applies only to those two existing routes. Offline tests cover every built-in route, app/server catalog consistency, JSON/multipart formatting, credentials, portrait/landscape/square sizes, binary/base64 images, conversion, saved recovery, and terminal failures without retries.

## Gateway request and recovery behavior

Every new generation skips Gateway caching so a batch of identical subjects produces separate sheets. Requests specify one maximum attempt; the Worker performs no automatic provider retry or fallback. Configure the Gateway consistently with this policy. The existing account allowance, global generation-count budget, and R2 storage remain in place. That budget counts attempted images, not dollars; different models have different costs. Gateway logging is controlled in Cloudflare and can include prompts and image responses.

A provider HTTP error, timeout, missing image, or malformed response is saved as a terminal failure with a generic message. Recovery returns HTTP 502, and repeating the same idempotency key does not invoke the provider again. The attempt still consumes its reserved account/global allowance because a provider may have performed billable work even when the response failed. Successful jobs keep their original image and metrics after routing changes. Reuse the original explicit model ID when retrying a POST; if the default changed since an omitted-model request, recover by `GET /v1/generations/{id}` instead. Registration, renewal, access reporting, and saved-image recovery remain available even if provider configuration is missing.

## Current deployment

AI Gateway was enabled on 23 September 2026. Gateway `coloring-sheets` is in account `994f60c144bd9dd9bc2333bd3abba832`, with authentication enabled, BYOK required (`byok_only: true`), caching disabled, logging enabled, and one maximum request attempt. The Worker uses `AI_GATEWAY_KEY_SOURCE=worker` and its existing `OPENAI_API_KEY`; the Gateway receives the separate Run token. No OpenAI key was copied into Gateway's Provider Keys.

Worker code was deployed with `--keep-vars`; after storing the dedicated Workers AI secret, version `62935cb9-fe6d-41d9-8bb6-f4d970987122` is active at 100%. The existing signing secret, provider key, R2/Durable Object bindings, 1,000-image account allowance, and 10,000-image global daily limit were preserved. OpenAI remains live. Both Cloudflare-hosted FLUX routes and the Images binding are deployed. With user approval, the existing Gateway Worker token was updated to Workers AI Edit, and a distinct “Coloring Sheets Workers AI” token was created from Cloudflare’s Workers AI template, scoped to this account, and stored as the encrypted WORKERS_AI_API_TOKEN secret. The temporary local copy was removed. Other providers still require their credentials and a model route.

Live verification passed for account access, model discovery, one OpenAI image through Gateway, and recovery of the identical saved PNG. The successful request used `gpt-image-2.5-flare`, returned a 1024 × 1456 PNG in about 11 seconds, and reported `viaGateway: true`, `provider: openai`, and 243 total tokens. The first verification attempt failed locally because Cloudflare's runtime rejects `redirect: "error"`; this was reproduced in local workerd and fixed using `redirect: "manual"` with non-2xx rejection. That first attempt never appeared in Gateway logs and consumed one reserved test allowance. The successful check consumed one further test allowance. Offline tests cover redirects and terminal failures as well as account and budget behavior.

### FLUX verification

Live checks passed on 23 September 2026 for both models through the deployed Worker, including JPEG-to-PNG conversion and recovery of the identical PNG from R2. Each successful generation used one account allowance; recovery used none. Both outputs were 1024 × 1456 and were visually inspected as black-outline coloring pages.

| Model | Worker duration | Gateway status | Cached | Gateway-reported inference cost |
| --- | --- | --- | --- | --- |
| FLUX.2 Klein 4B | 14.0 seconds | 200 | No | $0.00162976 |
| FLUX.2 Klein 9B | 2.6 seconds | 200 | No | $0.01584374 |

These are individual test observations, not latency guarantees or billing receipts. Images conversion and other Worker/storage usage are separate. The Gateway log IDs are `01M385NJAS2T7VNE4040G4C49F` (4B) and `01M385PNTVF10DQYSCJZ061CAB` (9B). Synthetic PNGs and metrics are saved locally in the Git-ignored `.build/flux-verification/` directory. Rebuild the iOS app to expose both FLUX options in Settings → Model; an already installed older build retains its original picker.

Offline Worker checks cover multipart formatting, separate credentials, size fitting, PNG conversion/pass-through, reservation limits, saved recovery, and terminal failures without provider retries. The actual local Cloudflare runtime also converted the real JPEG successfully. Simulator XCTest completed with 32 tests, one intentional live-test skip, and zero failures. The credential precheck was verified live to return HTTP 503 without spending allowance when the separate key is missing.

## Account renewal

`POST /v1/installations/renew` accepts `{}` with the saved bearer credential and returns a new 30-day access token for the same `accountId`. Only this endpoint accepts expired tokens: it still verifies the signature and checks the account’s current `credentialId`. It never creates a new account, resets allowance, spends credit, or invokes image generation. Credits and existing generation records remain attached to the account. Revoking its credential ID or rotating the signing secret blocks renewal as well as access.

The signed credential stored in the device Keychain provides long-term renewal access until revoked; the 30-day expiry limits direct API use, not the lifetime of the device identity. This supports already-expired credentials from existing app installations without discarding their accounts. The renewal endpoint was deployed on 23 September 2026 as version `742dc241-7c55-4c6c-afa7-b930011c790e`. That version was subsequently superseded by the AI Gateway deployment documented above. Offline tests cover expiry, retained credits/jobs, forged credentials, and revocation. The live renewal route returns its expected HTTP 401 JSON response for an invalid credential. Cloudflare blocks the default `Python-urllib/3.9` User-Agent with error 1010; curl and Python with an explicit `ColoringSheets-DeploymentCheck/1.0` User-Agent reach the Worker. This was isolated by changing only the User-Agent header in both clients. Use an explicit deployment-check identity for Python verification requests. An authenticated live renewal flow has not been exercised; the offline tests cover it.
