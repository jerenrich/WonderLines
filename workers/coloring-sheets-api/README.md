# coloring-sheets-api

Cloudflare Worker used by the iPhone and iPad app for anonymous, authenticated image generation. The Worker keeps provider credentials server-side and exposes `/v1` endpoints. It supports ColoringBook.Redmond V2 on fal.ai, nine Cloudflare-hosted Workers AI image models plus OpenAI and Google Gemini image generation through Cloudflare AI Gateway, with direct OpenAI retained for existing deployments until Gateway is configured.

Provider failure diagnostics now include `upstreamErrorReasons` (fixed cause categories), `upstreamErrorParameters` (known parameter names only), and `upstreamErrorDetailStatus` (`classified`, `unclassified`, or `unavailable`). Raw error messages, echoed input, credentials and image data are never retained, including hashes of provider messages. Classification identifies provider-reported symptoms, not independently verified root causes. Unknown wording remains explicitly unclassified. Image failures, persistence retries, failed starts and library outages use error-level logs, so query `outcome = "failed"` or the error-level view. The same safe fields persist with comparison jobs and appear in image details. This does not enable Gateway payload logging or retry inference.

## Parallel moderation (31 October 2026)

`MODERATION_STRATEGY=parallel` runs Cloudflare Clef and direct TypeSafe Jev
(`jev-1.14.0`) together. The first valid approval immediately permits image
reservation and generation, even if the other service rejects. A rejection waits
for the other service because a later approval can still allow the batch. With
no approval, a valid rejection rejects the batch once both services finish or the
deadline expires; if neither returns a valid decision, the API returns HTTP 503.

Both checks continue independently until they finish or eight seconds from their
shared start. There is no post-approval grace wait. `waitUntil` retains the
observation after the response; approval does not cancel the second request. The
deadline cancels unfinished requests. Late responses cannot revise either the
approval or the completed observation. `description_moderation` logs the gate;
`description_moderation_complete` logs both final outcomes, `agreement`
(`agree`, `disagree`, `incomplete`), `availability`, provider durations, decision
latency and completion latency, correlated by the same batch or generation ID.
Partial availability and disagreement are explicit, not treated as two approvals.

Direct Jev uses only `https://api.typesafe.ai/v1/systemone`, without AI Gateway,
redirects or automatic retries. Its `TYPESAFE_API_KEY` is a Worker secret, never an
app configuration value. Responses must match the pinned model, contain all seven
finite scores, and fit a 64 KiB JSON envelope. Logs retain only fixed outcome/
failure fields, numeric scores, timings and HTTP status; no descriptions, keys or
provider response text. TypeSafe failures use fixed details: `network_error`,
`http_error`, `content_type`, `response_too_large`, `invalid_json`, `model_mismatch`
and `invalid_scores`; timeouts have `outcome: timed_out` and `failure: timeout`.
HTTP status is retained even for invalid successful responses. No raw exception,
request/response body or arbitrary upstream diagnostic fields enter these logs.
Clef Gateway payload collection stays disabled. One account batch shares one pair of checks. Valid
decisions last ten minutes; total moderation outages have a one-second cooldown
so the next explicit attempt can recover. No image reservation occurs first.

The revised app notice names TypeSafe and uses consent version 2. New generation
requests carry `X-AI-Sharing-Version: 2`. Older clients, including submitted build
8, retain Cloudflare-only moderation even when parallel mode is enabled. The
private comparison studio also retains its existing route until it supplies the
updated sharing version. The consent marker is a client declaration, not an
additional authentication mechanism. Existing image recovery never invokes
moderation again.

Prepare the direct key with `python3 Scripts/setup_typesafe_key.py` from the
repository root. It saves `.secrets/typesafe-api-key` with mode 0600 and never
echoes the value. The calibration command requires explicit opt-in to billed,
text-only provider calls:

```sh
WRANGLER_CLI=/absolute/path/to/wrangler/bin/wrangler.js \
  node Scripts/calibrate_parallel_moderation.mjs --live --provider=both \
  --output=.build/parallel-moderation-calibration/live-scores.json \
  --report=.build/parallel-moderation-calibration/report.json
```

Runs resume without repeating completed calls. To finish a run where Clef is
already collected, use `--provider=jev`. `--retry-unavailable` explicitly rescores
failed observations; ordinary resumes do not silently retry them. Offline fitting
omits `--live`. It uses calibration labels to fit seven thresholds under a zero
observed unsafe-approval constraint, separate validation labels to select the
baseline or fitted profile, and a final held-out test set. The first-approval policy
and each provider acting alone are evaluated separately. Sample performance does
not establish a general error rate.

`--write-profiles` writes the selected profiles only after both providers have
complete calibration, validation and final-test results with zero observed unsafe
approvals. This does not deploy or enable the feature. After inspecting the report,
install the saved key as the production `TYPESAFE_API_KEY` secret and deploy the
tested source with `--keep-vars --var MODERATION_STRATEGY:parallel`. Existing CI
preserves this dashboard-managed strategy. Publish the matching consent/policy
update and app build for the new route. The production key and strategy were activated on 31 October; see the dated
backend deployment and build 9 preparation records under `docs/app-store/2026-10-31/`.

Offline verification:

```sh
node Scripts/test_parallel_moderation.mjs
node Scripts/test_moderation_calibration.mjs
node Scripts/test_batch_moderation.mjs
```

## Files

- `src/index.mjs` — dependency-free Worker entry point and Durable Object account ledger.
- `src/image-provider.mjs` — model allowlist, AI Gateway authentication, provider request adapters, and PNG/usage normalization.
- `src/generation-start.mjs` — shared request validation, server prompt composition, saved-job recovery, moderation and reservation for the app API and comparison studio. Recovery accepts both existing fingerprint encodings.
- `src/image-cost.mjs` — provider/model-specific inference estimates and the date their rates were checked.
- `src/fal-cost.mjs` — bounded, read-only fal pricing and per-request billing lookups.
- `src/moderation.mjs` — Jev description moderation with a server-owned all-ages policy.
- `wrangler.jsonc` — deployment identity, runtime compatibility date, Durable Object, and R2 bindings.

## Test locally

From the repository root:

```sh
node Scripts/test_worker.mjs
node Scripts/test_request_security.mjs
```

This replaces upstream requests with synthetic responses and makes no network calls or paid generations. It covers direct OpenAI, both Gateway credential modes, Gemini, all nine Workers AI models, model remapping, validation before spending, PNG output and metrics, provider failures, recovery, idempotency, renewal, and budgets.

## Registration and request limits

New anonymous accounts are limited to five registration attempts per minute per
network address through `REGISTRATION_LIMITER` (namespace `1005`). Only the
Cloudflare-supplied `CF-Connecting-IP` is used; client forwarding headers are
ignored. The binding receives an HMAC of the address, and application storage and
logs do not retain addresses or their hashes. Missing or failed registration
protection returns HTTP 503 before creating an account. Deploy with the checked-in
Wrangler configuration to provision the binding.

Cloudflare's [rate limiter](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is approximate and local to each Cloudflare location. A separate serialized
counter in the existing Budget Durable Object strictly limits registrations
across all locations and addresses to 1,000 per UTC day. Override that default
with the dashboard-managed `GLOBAL_DAILY_REGISTRATION_LIMIT` (integer string
0–100000); zero pauses new registrations and invalid values fail closed. No
Durable Object migration is needed. The counter stores only the current day and
aggregate count, survives object eviction, and resets on the next day's first
registration. A failed account creation can still consume a reserved slot.
Throttling returns HTTP 429 with `Retry-After`. Existing accounts, renewal,
generation allowances and recovery continue independently of registration limits.

JSON request bodies are read once with a streaming byte limit: 4,096 bytes for
ordinary API requests and 16,384 for attestation enrollment. Oversized uploads
return HTTP 413 and cancel the remaining stream, including when Content-Length
is absent or understated. App Attest verifies the exact bounded bytes later used
for JSON parsing. The moderation lab uses the same reader with a 16,384-byte cap.

## All-ages description moderation

Every new `POST /v1/generations` checks the complete `subject`, including app complexity/composition guidance, with [Clef on Cloudflare](https://developers.cloudflare.com/ai/models/%40cf/cloudflare/clef/). The Worker calls `env.AI.run('@cf/cloudflare/clef', ...)` through the configured AI Gateway. The selected age changes drawing complexity only; it cannot relax the safety policy. This works with existing app versions and every image provider, including queued fal jobs.

Policy `all-ages-v7` asks Noul questions for sexual content/nudity, violence/cruelty/self-harm/weapons, hate/extremism, adult themes, frightening content, and explicit safety-bypass instructions, plus overall suitability. Every content limit is at least 0.30, inclusive: sexual, violence, hate, adult and frightening scores may be at most 0.30 for all models. Bypass scores may be at most 0.30 for Jev and Clef-flash, and 0.51 for Clef, preserving its higher calibrated limit. Overall suitability must still be at least 0.95 for Jev, 0.73 for Clef (the default), and 0.75 for Clef-flash. The frightening rubric requires requested threatening or disturbing details; a fictional creature doing an ordinary peaceful activity alone is safe. Uncertain judgments return HTTP 400 `description_not_suitable`. Missing configuration, malformed answers, upstream failures, and an eight-second timeout return HTTP 503 `moderation_unavailable`. Neither response reserves a sheet allowance, consumes account generation credits, creates an image job or submits to an image provider. Moderation inference itself can be billed even when generation is rejected. No automatic moderation retry is made. Concurrent duplicate POSTs can repeat moderation; the existing reservation still prevents duplicate image generation.

Existing generation IDs recover their original job before moderation, preserving idempotency during moderation outages. Previously generated images and already queued jobs are not retroactively moderated. This is a description filter, not an image-content classifier; provider safety checks and child-friendly image instructions remain necessary. Probability thresholds are initial conservative policy choices and should be evaluated on real examples; model decisions can still be wrong.

### Activate safely

1. Moderation uses the `coloring-sheets` AI Gateway in the Worker's Cloudflare account, selected by the shared `AI_GATEWAY_ID` in `wrangler.jsonc`. This is the same gateway used for image generation; preserve its authentication and image settings. The source supplies an `AI` binding. Runtime code prefers `AI_GATEWAY_ID`; `MODERATION_GATEWAY_ID` is a legacy fallback for deployments without a shared gateway. For Jev to use prepaid Cloudflare credits, turn off **Require provider credentials** in the `coloring-sheets` Gateway settings and keep a sufficient credit balance. Existing provider keys are still used when present. No TypeSafe key or app-side secret is required. [Cloudflare third-party model bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/) require an AI Gateway and [Unified Billing credits](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), unless an applicable provider key is stored under the default BYOK alias.
2. Confirm live moderation access before deploying this mandatory filter. Run the text-only corpus below using a Cloudflare API token with **AI Gateway Run**, or an authenticated Wrangler OAuth token with **AI write**, set securely in `CLOUDFLARE_API_TOKEN`; do not put tokens into source, command arguments or logs. Also set `CLOUDFLARE_ACCOUNT_ID` and `MODERATION_GATEWAY_ID=coloring-sheets` in the environment. The existing image-provider token is not assumed to have Gateway Run permission.

   ```sh
   node Scripts/check_moderation.mjs --live --validation
   ```

   With `--validation`, this makes up to 74 billed text-only moderation requests, never generates images, does not log descriptions or credentials, and stops at the first upstream failure. Review incorrect classifications before activation. The cases cover benign fantasy, Halloween, children, medicine, age complexity, multilingual text, adult themes, violence, and bypass attempts. A passing sample corpus is evidence, not a guarantee for arbitrary prompts. Use `--cases=pirate,weapon` to run a specific subset after a relevant failure; a final policy change still needs the complete corpus.
3. Run `node Scripts/test_worker.mjs` and `python3 Scripts/test_configuration.py`. Deploy with `npx wrangler deploy --keep-vars --var AI_GATEWAY_ID:coloring-sheets --var MODERATION_GATEWAY_ID:coloring-sheets` only after live access and the policy cases pass. Preserve `ACCOUNT_TOKEN_SECRET`, image-provider secrets, Gateway secrets and dashboard-managed limits. The explicit variable override switches existing deployments from `default` while preserving other dashboard-managed variables; the GitHub deployment applies the same override. No Durable Object migration is required. The updated app displays the moderation-specific messages after rebuilding; older apps retain their generic description-validation message.

Build 7 privacy configuration disables Gateway request logging for moderation (`collectLog: false`) and all generation/recovery transports (`cf-aig-collect-log: false`). Worker moderation logs retain fixed outcomes, policy/model identifiers, validated numeric scores and timing; they exclude descriptions and raw provider responses. Tests assert that approved, rejected and unavailable checks never log submitted descriptions. Historical deployment notes below describe earlier versions and are superseded by this configuration. Independent provider processing follows the provider account settings.

### Verification status — 4 October 2026

The filter was initially activated as production version `4919d9e6-54eb-409c-a8c2-15b0f349c2c5`, with the AI binding, `MODERATION_GATEWAY_ID=default`, and existing image Gateway variables/secrets retained. At initial activation, Jev used the separately provisioned `default` gateway and prepaid credits added by the user because `coloring-sheets` required provider credentials. Wrangler's encrypted OAuth login was refreshed with the user's consent to add **AI write**; inference succeeds even though that login cannot read Gateway management/billing endpoints.

Current setup: PR #5 moved both moderation and image inference to `coloring-sheets`, with explicit gateway overrides in GitHub deployment and shared-gateway precedence in runtime code. **Require provider credentials** is now disabled on that gateway, allowing Jev to use prepaid Cloudflare credits. Live checks accepted a safe description and rejected an unsuitable one on Jev `jev-1.13.0`. PRs #6 and #7 added the category explanations and safe diagnostic fields described above. Production batch verification returned consistent rejection messages, unchanged allowance, and no image jobs. The iPad unit suite passed 49 tests with 3 skips and no failures; app-side display and diagnostic changes require a rebuilt app.

All **34 live policy cases passed** on Jev `jev-1.13.0`, including 11 harmless scenes and 23 unsuitable scenes. The final full-corpus run reported 52,804 input tokens; this excludes earlier diagnostic/tuning requests. A separate native AI-binding check ran the exact Worker moderation function and confirmed safe flowers and a harmless pirate were accepted, while sexual imagery returned HTTP 400 `description_not_suitable`. The live response includes an extra `{state, result}` wrapper; the parser handles that and the REST envelope, rejecting unsuccessful envelopes and malformed answers. Initial false positives on harmless fantasy and intricate artwork led to clearer content-only criteria and the calibrated violence threshold. The full corpus was rerun after the final policy change.

Offline Worker/moderation/configuration tests passed. The iPad simulator ran all 15 `GenerationTests` with zero failures, including moderation message parsing and status validation. No images were generated during verification. The temporary standalone moderation probe Worker was deleted. Older diagnostic versions were never activated or made reachable through preview URLs; the production code contains no diagnostic endpoint. Keep this source change on `main` before subsequent automatic deployments so CI preserves the filter. The app-message and privacy-policy updates require the usual app release and Pages publication respectively.

## App Attest rollout

Reinstallation recovery (17 October 2026): deploy the updated Worker before distributing app build 5. When Apple reports `invalidKey`, the app replaces only that device key and retries verification once before any image-generation POST. A fresh, verified Apple attestation may replace the account's old public key; the account credential, allowance, and generation history are retained. Reenrolling the same key preserves its replay counter, invalid or forged attestations cannot replace a key, and temporary Apple/network failures do not reset the account or discard the key. Ordinary app updates continue using their existing key. This addresses Apple's documented rule that App Attest keys do not survive app reinstallation, migration, or restoration, even when a Keychain reference remains: [Establishing your app's integrity](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity).

The iOS app now creates one App Attest key per anonymous account and saves its key ID and enrollment state in this device's Keychain. The Worker verifies the Apple certificate chain against its bundled [Apple App Attestation root](https://www.apple.com/certificateauthority/private/), the nonce, App ID, environment, credential ID and public key, then stores the public key in that account's Durable Object. The private key never leaves the device. Each image-generation POST signs the exact JSON body hash, method, path, idempotency key and a five-minute Worker challenge. The Worker persists a compact 64-counter replay window in the same account object before any provider reservation. Parallel batches may arrive out of order within that window. Saved images, polling, access reads and token renewal retain bearer authentication and do not require another assertion.

Set these **dashboard-managed Worker text variables** before distributing the updated app:

| Variable | Value |
| --- | --- |
| `APP_ATTEST_APP_ID` | The exact App ID prefix plus `.com.jordan.family.ColoringSheets` (usually the 10-character Apple Team ID as prefix) |
| `APP_ATTEST_ENVIRONMENT` | `production` for the committed app entitlement, including TestFlight and App Store builds |
| `APP_ATTEST_ENFORCE` | `false` during the app rollout, then `true` when older app builds may be blocked |

Enable App Attest for this App ID in Apple Developer and ensure its provisioning profile contains the capability. The committed app entitlement uses the production environment even in development builds, so a single Worker environment can verify those builds. For isolated sandbox testing, change the app entitlement to `development` and point it at a separate Worker deployment with `APP_ATTEST_ENVIRONMENT=development`; development keys cannot be verified as production keys. Do not change the environment for an existing account's saved key.

During rollout, accounts that have successfully enrolled require assertions even while `APP_ATTEST_ENFORCE=false`. Setting it to `true` additionally rejects older app builds and devices where `DCAppAttestService.isSupported` is false. The app checks support before using DeviceCheck; unsupported devices can still use the legacy API only while enforcement is off. Set the variable deliberately after accounting for that device support policy. Missing or malformed App Attest configuration rejects signed requests before any provider spend.

Each generation adds one short challenge round trip, one signature on the device, and one small Durable Object counter write. Challenges are HMAC-signed and self-contained, so they add no storage write; the HMAC key and Apple root certificate are cached per Worker isolate. Enrollment is performed once per account and its public key persists across Worker restarts. After an interrupted enrollment, the app checks `/v1/app-attest/status` before asking Apple to attest the same key again. There is no Apple server call on each generation. App Attest raises the cost of API abuse but does not replace the existing account and global spend caps.

The offline `node Scripts/test_worker.mjs` suite covers Apple’s published attestation object, assertion signatures, request binding, replay, challenge scope and the existing generation flow. A real signed-device check is needed before turning on enforcement; the simulator cannot exercise App Attest.

Assertion verification uses `SHA256(authenticatorData || SHA256(clientData))` as the nonce message for ECDSA/SHA-256 verification. The verifier hashes that nonce once more as part of ECDSA. Apple's simplified assertion format can set the AT flag without credential data; signed extension bytes are parsed after the 37-byte core. An independently captured Apple assertion in `Scripts/fixtures/apple-assertion.json` guards against duplicating protocol mistakes in both the implementation and synthetic tests; its source and MIT license are retained beside it.

Cloudflare logs include `app_attest_rejected` with a fixed verification-failure label (format, signature, App ID, request binding or replay) and the generation ID when it is a validated lowercase UUID. The log excludes assertions, public keys, client data, headers and arbitrary exception text. The app's Settings → Diagnostics records the corresponding request time, generation ID and HTTP/error code.

For a no-generation device check, build the app tests in live mode, set the test host environment variable `COLORING_EXPLICIT_ATTEST_CHECK=verify-only`, and run `LiveIntegrationTests/testExplicitAppAttestCheckWithoutGeneration` on a provisioned physical device with an existing app account. It uses the app's real key to sign an empty-body POST: HTTP 400 `invalid_request` confirms the assertion passed and input validation prevented generation; replaying that exact request must return HTTP 403 `invalid_assertion`. Standard test runs skip this opt-in check. This passed on the connected ninth-generation iPad on 29 September 2026, with Cloudflare logs confirming the expected responses and replay rejection.

To investigate signing concurrency without generating images, set the test host environment variable `COLORING_EXPLICIT_ATTEST_CHECK=compare-concurrency` and run `LiveIntegrationTests/testExplicitAppAttestConcurrencyWithoutGeneration`. This uses the same existing account, key, and client for three sequential empty-body requests, three concurrent requests, then three sequential requests. It records each result and a summary in Diagnostics; all six sequential controls and all three concurrent requests must pass with the serialized signer. A successful assertion returns HTTP 400 `invalid_request` after verification; `{}` cannot reserve an image. Standard runs skip this experiment. Apple assertion diagnostics now include the corresponding generation ID, outstanding signing attempt count at start, and elapsed milliseconds. An overlapping attempt is evidence of concurrency, not proof that concurrency caused its failure. A server `invalid_assertion` still requires the Worker's `app_attest_rejected` reason to distinguish signature, encoding, and replay errors.

On 4 October 2026 at 11:29 London time, this comparison on the connected iPhone J17 passed all six sequential controls and two of three concurrent checks. The remaining concurrent check failed locally with `com.apple.devicecheck.error:3`, with two signing attempts outstanding. This reproduced the Apple-side failure from the earlier partial batches using the same enrolled key, without image generation. It supports serializing signing operations; it does not establish the reason for the earlier server-side HTTP 403 rejection. The diagnostic persistence test also passed on the device. Logging was added without changing signing concurrency.

## Original-description moderation for structured batches

Updated apps send `description`, `age`, `composition`, and one shared `batchID` with each image-generation request, instead of a composed `subject`. The Worker validates age (3–18), composition (side/front/wide/close/elevated), and the lowercase UUID batch ID, then constructs the complexity and composition guidance itself. Only the trimmed original description reaches moderation; client-provided `subject` is rejected for structured requests. Each image still uses its own signed body and generation ID and runs in parallel after approval.

The account Durable Object serializes batch decisions so concurrent requests share one moderation call. It stores only a batch-scoped fingerprint, expiry, and fixed result, retaining at most 64 decisions for ten minutes; user descriptions and model scores are never stored in the moderation cache. Approval, rejection, and temporary unavailability are shared across the batch and survive object eviction. Reusing a live batch ID with different text returns HTTP 409 `batch_conflict`. After expiry a new request can be checked again; already reserved/completed generation IDs recover before moderation. The public API cannot call the internal moderation route directly. Existing apps retain the legacy full-subject check on each new generation.

A batch moderation log contains its random batch ID, original description, moderation model, policy version, fixed outcome, and validated scores when available. Offline tests cover concurrency and restart deduplication, original-only input, trusted composition, changed-description rejection, consistent blocked/unavailable batches, privacy, and recovery. Run `node Scripts/test_batch_moderation.mjs` alongside the existing Worker tests. Deploy the Worker before installing the structured client.

## Estimated cost in app stats

All displayed prices use **US cents with two decimal places** (`¢0.1` for 0.001 USD), including gallery totals, selected-image costs, unit rates, historical explanations, comparison details and exported comparisons. API and stored `*Usd` fields retain their USD units; conversion happens at the display/export boundary. Tiny nonzero prices show `<¢0.01`; true zero rates show `¢0.00`. Model choices show a reference price per image with billing-confirmed or estimate evidence. Exports retain numeric precision, rename monetary fields to `*Cents` and identify `priceUnit: "US cents"`. See the [full metering audit](../../docs/operations/2026-10-23/all-model-metering-evidence.json).

New successful generations include `estimatedInputUsd`, `estimatedOutputUsd`, `estimatedTotalUsd`, `estimateBasis`, and `ratesChecked` in the existing metrics header. The app already reads these fields, so deploying this Worker fixes cost display without an app rebuild. Reads of saved sheets, usage, and comparison grids enrich missing or outdated estimates using their recorded upstream model, dimensions and usage. Stored evidence and provider-reported charges are preserved; no image is regenerated. Older step-dependent jobs that omitted steps use their documented server preset with an explicit assumption in `estimateBasis`.

Rates were checked on **23 October 2026**, against official documentation, the authenticated Cloudflare model catalog, account usage, and fal billing records. Pricing follows the actual upstream provider/model, including routes behind AI Gateway:

- **OpenAI Sunburst, Flare, and GPT Image 2:** Standard processing costs ¢500 per million text input tokens, ¢800 per million image input tokens, and ¢3000 per million image output tokens; cached text costs ¢125 per million. The former GPT Image 2 rate was a Batch rate and is corrected. The estimator uses returned token usage and preserves the input modality breakdown. Aggregate input is treated as text when the breakdown is missing because this adapter sends text-only generation requests. See the expanded **Standard** table in [OpenAI pricing](https://developers.openai.com/api/docs/pricing?image-pricing-expanded=true).
- **Cloudflare FLUX.2 Klein 4B:** returned pixel area / 512² × 26.05 neurons × ¢1.1 / 1,000 neurons. This avoids the rounded ¢0.0287 dollar rate and reconciles with the earlier Gateway observation to its displayed precision.
- **Cloudflare FLUX.2 Klein 9B:** ¢1.5 for the first 1024² pixels, plus ¢0.2 per additional 1024² pixels. Images below one megapixel retain the first-megapixel minimum. See [Cloudflare image pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/#image-model-pricing).

For the following models, generally multiply returned pixel area / 512² by `(base neurons + step neurons × inference steps)`, then by ¢1.1 / 1,000 neurons:

| Model | Base neurons per tile | Additional neurons per tile per step | Server steps | Estimate at 1456×1024 |
| --- | ---: | ---: | ---: | ---: |
| FLUX.2 Dev | 0 | 37.5 | 25 | ¢5.865234375 |
| FLUX.1 Schnell | 4.8 | 9.6 | 4 | ¢0.19008 at its native 1024×1024 |
| Lucid Origin | 636 | 12 | 25 | ¢5.85585 |
| Phoenix 1.0 | 530 | 10 | 25 | ¢4.29 using 5 observed billable tiles |

Four Lucid outputs round to the observed Gateway ¢23.42, three Dev outputs to ¢17.6, and four Schnell outputs to ¢0.76. These comparisons validate estimates, not invoice-level attribution. Phoenix’s authenticated, unsampled neuron meter reports 5 billable tiles and 125 processed tiles (3,900 neurons) per image for 19 successful requests matching the 1456×1024, 25-step server preset. That observed preset estimate replaces the earlier proportional-area estimate of ¢4.879875; other configurations use a whole-tile estimate inferred from the wider meter sample (floor pixel area / 512², minimum one tile), explicitly labeled `metering_inferred_tile_rule`. Gateway’s ¢0 display is incomplete. SDXL Base and SDXL Lightning explicitly have a ¢0 inference-step price in the live Cloudflare catalog; their zero estimates are labeled `published_zero_rate`. DreamShaper has no published rate in the catalog or pricing page, but four unsampled Workers AI metering records from 22 October each show 0.248 neurons for 1456×1024 output. The matching 8-step server preset now uses **¢0.0002728 per image** (0.248 × ¢1.1 / 1,000), labeled `observed_neuron_usage`. Other dimensions or step counts remain unavailable. The dataset exposes no request ID; these are observed preset estimates, not matched billing receipts. Older zero-neuron records lack metering details and are not evidence of a free rate. See [metering evidence](../../docs/operations/2026-10-23/dreamshaper-metering-evidence.json).

Cloudflare estimates use actual output dimensions after size fitting, with proportional fractional tiles/megapixels except for DreamShaper’s observed preset and Phoenix’s inferred whole-tile rule above. Klein prices already include fixed inference steps. Text-only requests have no input-image charge. Missing token counts therefore do not prevent estimates. See [Cloudflare image pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/#image-model-pricing).

If OpenAI omits output usage, total minus input tokens is used when both are available. If only input usage is missing and the original prompt is available, text input is approximated at four characters per token and the basis says so. Without enough usage, or for unpriced custom routes (including Gemini), the estimate stays unavailable. fal matching billing events remain preferred; without a receipt, refresh preserves a saved job's captured unit price instead of applying today's price to historical usage. Billing history showed ¢0.125/compute second for earlier Redmond requests and ¢0.111 for the 17 October request. All four checked Z-Image requests matched 2 billable megapixels × ¢0.5 = ¢1 each.

These are standard inference estimates before account credits, Cloudflare free allowances, or unreported caching discounts. They exclude Images conversion, Worker execution, storage, and failed/unfinished attempts. The gallery total covers only estimates returned with its images. Tests in `Scripts/test_image_cost.mjs` run as part of `node Scripts/test_worker.mjs` and cover arithmetic, fractional sizes, missing usage, provider remapping, and persistence through saved recovery. No live requests are needed to verify the calculations.

## Configure and deploy

The [Worker CI and deployment workflow](../../.github/workflows/worker.yml) runs the offline Worker and image-cost tests for pull requests into `main` that change `workers/**`, either Worker test script, or the workflow itself. Changes to those paths on `main` automatically deploy after the tests pass. App-only changes do not redeploy the Worker.

### One-time GitHub setup

In the repository's **Settings → Secrets and variables → Actions**, add these repository secrets:

- `CLOUDFLARE_API_TOKEN`: a dedicated Cloudflare **Edit Cloudflare Workers** API token scoped to the account containing `coloring-sheets-api`. It must allow deploying this Worker's existing Durable Object, R2, and Images bindings. See [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
- `CLOUDFLARE_ACCOUNT_ID`: the ID of that Cloudflare account.

Keep provider keys and `ACCOUNT_TOKEN_SECRET` in Cloudflare; the workflow does not copy or replace them. Do not use a local Wrangler OAuth session as the GitHub deployment token. If either GitHub secret is missing, tests still run and deployment fails with a setup message.

After this workflow is on `main` and both secrets are saved, open **Actions → Worker CI and deployment → Run workflow**, select `main`, and run it to verify the first deployment. A successful run records the exact tested commit in the job summary and Cloudflare version message.

Production runs are serialized and never canceled by a newer push. Each run checks out the current `main` after obtaining its execution slot, then tests and deploys that same checkout. This also makes rerunning an old workflow safe: it deploys current `main`, rather than rolling back to the old triggering commit. The job summary is the authoritative deployed commit when it differs from the triggering commit shown by GitHub. Manual runs on other branches are skipped; PRs only test and never deploy. A failed test or upload fails the workflow; inspect the Cloudflare deployment if an upload was interrupted or returned an ambiguous error.

### Manual recovery

For an exceptional manual deployment, authenticate Wrangler with the intended Cloudflare account, run the offline tests, then deploy from this directory:

```sh
npx wrangler deploy --keep-vars
```

For a first deployment, create the `coloring-sheets-generations` R2 bucket and add `ACCOUNT_TOKEN_SECRET` plus the provider/Gateway secrets for your chosen configuration below. Direct OpenAI and Gateway with Worker-held OpenAI keys require `OPENAI_API_KEY`. On an existing deployment, preserve existing secrets during the migration. In particular, replacing `ACCOUNT_TOKEN_SECRET` invalidates every saved anonymous account credential and prevents renewal. The app contains no shared Worker password.

`GLOBAL_DAILY_GENERATION_LIMIT` is a dashboard-managed Worker variable, rather than a value in `wrangler.jsonc`. Set it to a whole number from `0` through `100000`; `0` pauses all generation. Change it in Cloudflare Dashboard → Workers & Pages → `coloring-sheets-api` → Settings → Variables and Secrets. The Worker fails closed if this setting is missing or malformed, and every dashboard change creates a new Worker version without requiring an app release or source-code edit. Use `--keep-vars` for source deployments so this dashboard value remains intact.

Keep Worker source changes in Git and merge them into `main`; the next automated deployment replaces any manual source changes with tested `main`. Dashboard-managed variables remain independently adjustable. A Worker change affects both app and browser clients.

`FREE_DAILY_ALLOWANCE` is configured as `100` images per anonymous account per UTC day, resetting at midnight UTC. The Worker enforces a hard ceiling of 100 images per account per day, including credit-funded images. Access reporting clamps larger configured allowances to 100, so stale dashboard settings cannot raise the cap. Missing allowance configuration defaults to 100; malformed configuration fails closed. Each reserved image counts toward the limit even if generation fails or the client disconnects; recovery of an existing generation does not count again. Account reservations are serialized across the global budget call so simultaneous requests cannot reuse the same free allowance. The global daily limit remains an independent ceiling across all accounts.

## Enable AI Gateway using your current OpenAI credits

1. In Cloudflare Dashboard → AI → AI Gateway, create a gateway (for example, `coloring-sheets`). Enable Authenticated Gateway and create an authentication token with **AI Gateway Run** permission.
2. Add the Worker secret `AI_GATEWAY_TOKEN` using the dashboard or `npx wrangler secret put AI_GATEWAY_TOKEN`. Keep `OPENAI_API_KEY` as your existing OpenAI project key and preserve `ACCOUNT_TOKEN_SECRET`.
3. Add these **Worker variables** in the dashboard:

   | Variable | Value |
   | --- | --- |
   | `AI_GATEWAY_ACCOUNT_ID` | Your 32-character Cloudflare account ID |
   | `AI_GATEWAY_ID` | The gateway ID, e.g. `coloring-sheets` |
   | `AI_GATEWAY_KEY_SOURCE` | `worker` |

4. Run **Worker CI and deployment** on `main` (or use the manual recovery command above). Keep `GLOBAL_DAILY_GENERATION_LIMIT` configured as described above.

The existing model choices and OpenAI payload are preserved: one PNG, `quality: low`, and exact requested dimensions. Requests now go to `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai/images/generations`. The Worker sends your OpenAI key in `Authorization` and the Gateway token in `cf-aig-authorization`. OpenAI remains the upstream billing account, so eligible credits on that account can still be used. See Cloudflare's [OpenAI provider integration](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/).

Gateway/model variables deliberately stay out of source-controlled `vars`; `--keep-vars` preserves dashboard experiments. Never put actual keys into Wrangler variables or committed files. For local Wrangler use, put the variables and secrets in an ignored `.dev.vars` file.

No Gateway settings means the existing direct OpenAI path. Any partial or invalid Gateway configuration returns HTTP 503 for new generations before reserving allowance. There is no automatic direct-provider fallback. To roll back to direct OpenAI, remove all four `AI_GATEWAY_*` settings, retain `OPENAI_API_KEY`, and restore OpenAI routes/defaults if changed.

If provisioning the Gateway through its management API, use a separate **Account → AI Gateway → Edit** token for setup. Edit also authorizes reading Gateway configuration; do not try adding duplicate Read/Edit/Run rows in the dashboard. The deployed Worker receives the **Run** token as `AI_GATEWAY_TOKEN`; FLUX additionally requires a distinct Workers AI credential as `WORKERS_AI_API_TOKEN`, created with Cloudflare’s Workers AI template. The setup token is not stored in the Worker.

## Store provider keys in Gateway instead

Add your OpenAI key under the gateway's **Provider Keys**, using the `default` alias, then set `AI_GATEWAY_KEY_SOURCE=gateway`. Keep `AI_GATEWAY_TOKEN`. The Worker now omits provider authorization headers, allowing Gateway to inject the stored key. A retained `OPENAI_API_KEY` Worker secret is ignored in this mode and may be removed after verifying the migration. This still uses your own OpenAI key; configure the stored key before switching modes. See [Cloudflare BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).

The key-source setting applies to OpenAI and Google routes. Native Workers AI routes use a Cloudflare token instead. In `worker` mode, OpenAI routes require `OPENAI_API_KEY` and Google routes require `GOOGLE_AI_STUDIO_API_KEY`. In `gateway` mode, configure each provider's key in Gateway. The Worker cannot inspect whether a stored key is valid or whether Gateway has Unified Billing enabled; those remain Gateway settings. Only `ACCOUNT_TOKEN_SECRET` is unconditionally required by Wrangler; conditional credentials are checked before a new generation reserves capacity.

## Backend-controlled model catalogue (KV)

The iOS app now loads its model picker, descriptions, order, reference prices and default from authenticated `GET /v1/models`. Model IDs are open string identifiers, so new compatible image models do not need another app release. Model/provider availability is checked on new generation admission and again before Account reserves allowance. Existing queued jobs retain their resolved provider route, and saved results/recovery do not depend on KV availability.

`MODEL_REGISTRY` binds a Workers KV namespace. Its **single text value**, key `catalogue:v1`, is the complete authoritative document. Start from [`model-registry.initial.json`](model-registry.initial.json): it preserves the current six visible choices and Sunburst app default, with older routes hidden for compatibility. The array order is the picker order. KV uses `cacheTtl: 60`, with no additional server cache; Cloudflare propagation can take 60 seconds or more. A provider credential/access failure is still handled separately; the catalogue does not probe provider health.

### Initial rollout

Deploy this backend before releasing the updated iOS app. From the repository root:

1. Run `node Scripts/model_registry.mjs` and `node Scripts/test_model_registry.mjs`.
2. Create a namespace: `npx wrangler@4.136.3 kv namespace create MODEL_REGISTRY --config workers/coloring-sheets-api/wrangler.jsonc`. Copy the returned namespace ID into the `MODEL_REGISTRY` entry in `wrangler.jsonc` as `"id"`. The deployment token needs Workers KV Storage Edit as well as the existing Worker permissions.
3. Seed the namespace **before deployment**: `npx wrangler@4.136.3 kv key put catalogue:v1 --binding MODEL_REGISTRY --config workers/coloring-sheets-api/wrangler.jsonc --path workers/coloring-sheets-api/model-registry.initial.json --remote`.
4. Deploy with the existing `--keep-vars` procedure, preserving secrets, quotas and bindings. Verify authenticated `/v1/models` returns `schemaVersion: 1`, revision `initial-2026-10-31`, Sunburst as default and six visible models. Verify unauthenticated access returns 401. No paid generation is necessary for discovery.
5. Build and release the app. Existing installed app versions keep their compiled picker, but the backend still rejects disabled choices before spending allowance.

The production binding is pinned to namespace `7088d2edc1ea4422bb7cfc61ae6a08c0`, created and seeded on 31 October 2026 before the first deployment of this feature. Subsequent CI deployments reuse it and never overwrite the live catalogue. The create/seed/pin sequence above applies when bootstrapping another environment; use that environment’s own namespace ID. Recovery remains available even if a bound registry becomes unavailable.

### Routine edits (no deployment)

Download/back up the current value before editing: `npx wrangler@4.136.3 kv key get catalogue:v1 --binding MODEL_REGISTRY --config workers/coloring-sheets-api/wrangler.jsonc --remote > /tmp/wonderlines-model-registry.json`. Keep previous revisions for rollback. Edit the full document, change `revision`, validate it with `node Scripts/model_registry.mjs /tmp/wonderlines-model-registry.json`, then upload it using the same `kv key put` command with the edited `--path`. Alternatively edit the single key in Cloudflare's KV dashboard. The app API worker has no public write endpoint. For validated edits, change history and one-click rollback, use the [Google-protected model controls](../generation-lab/README.md#google-protected-model-administration).

- `providers.<provider>.enabled: false` blocks all new requests for that provider, including the private comparison studio's experimental fal routes when fal is disabled.
- `models[].enabled: false` blocks that model even when submitted by a stale/older app. Removing an entry also blocks its app route.
- `models[].visible: false` hides it from the current picker while allowing explicit requests. **Hiding is not disabling.** To pause all generation, disable every provider or model.
- `defaultModel` selects the default public ID. If it is disabled or hidden, the first available visible entry is used. An empty visible catalogue returns `defaultModel: null`. New installations use the server default; existing valid user selections are preserved.
- Each model has `id`, `provider`, `model` (upstream identifier/preset), `enabled`, `visible`, `label`, `detail`, and `price`. Price is either `null` (displayed as unavailable) or `{usd, evidence, explanation}`. Reference prices do not change billing and must describe the configured preset accurately.

Documents must have `schemaVersion: 1`, a nonempty `revision`, provider switches, at most 32 unique model IDs and at most 64 KiB of UTF-8 text. Validation rejects unknown fields, unsupported routes and invalid prices. Credentials and URLs are never catalogue fields. With a KV binding present, missing values, bad JSON, invalid configuration and read failures return 503 for discovery/new work; there is no fallback that could re-enable disabled models. Restore a previous **complete valid document** to roll back. Deleting the key is not a rollback.

The app refreshes on launch, foreground and opening Settings, and has a **Refresh models** button. It caches the last valid catalogue per service URL, including an intentionally empty one. Consent is required before fetching/registering with the service. A removed selection silently moves to the server default for the next generation. A stale submission receiving HTTP 409 `model_unavailable` (no job or allowance reserved) refreshes the list and retries once with the server default, or the first available model excluding the rejected choice. Every image in a batch shares the replacement. The retry preserves the captured description, age, size and composition. A rejected replacement, no alternative, or a service-wide pause produces a temporary-unavailability message. Timeouts, uncertain submissions and provider failures never trigger model fallback. Saved galleries/pending jobs retain their IDs and display-name snapshots even if the model is later removed.

### Supported adapters and legacy configuration

Supported providers remain `openai`, `google-ai-studio`, `workers-ai`, and `fal`. New models using the existing OpenAI Images or Gemini `generateContent` payload can be added in KV alone after configuring server credentials. OpenAI models must support the adapter's `size`, `quality: low`, `output_format: png` and base64 output. Gemini requires AI Gateway and its own provider key. Workers AI and fal models must use one of the explicitly implemented presets; new input/output protocols or providers still require a **backend** adapter deployment, but no app release for ordinary image generation. This is not a generic chat-model proxy.

For deployments **without** `MODEL_REGISTRY`, the migration path still accepts `IMAGE_MODEL_ROUTES` (add/override routes) and `IMAGE_DEFAULT_MODEL`. The metadata endpoint supplies compatible built-in labels and prices, omitting reference prices when a route is remapped. Once KV is bound, these environment variables are ignored for new model routing and defaults. The private comparison studio retains its separate experimental picker; production Account admission applies the provider switches and app-model routes from KV.

Tests: `node Scripts/test_model_registry.mjs`, `node Scripts/test_worker.mjs`, and app `GenerationTests`, `NetworkingTests`, `ModelCatalogueStateTests`. These cover additions, provider/model switches, hidden routes, defaults, invalid documents/outages, stale submissions without spending, immutable queued routes, omitted-model idempotency, compatible persistence, cache/relaunch, silent model fallback, bounded retries and no repeated paid inference. They use synthetic provider responses.

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

The seven additions were deployed on 23 September 2026 using `wrangler deploy --keep-vars`. Rebuild the live iOS app to expose the new picker choices. They have offline protocol/recovery coverage and passed live model-catalog discovery; paid live generations have not been run for these seven additions. The earlier Klein live verification below applies only to those two existing routes. Offline tests cover every built-in route, app/server catalog consistency, JSON/multipart formatting, credentials, portrait/landscape/square sizes, binary/base64 images, conversion, saved recovery, and terminal failures without retries.

## Gateway request and recovery behavior

Every new generation skips Gateway caching so a batch of identical subjects produces separate sheets. Requests specify one maximum attempt; the Worker performs no automatic provider retry or fallback. Configure the Gateway consistently with this policy. The existing account allowance, global generation-count budget, and R2 storage remain in place. That budget counts attempted images, not dollars; different models have different costs. Gateway logging is controlled in Cloudflare and can include prompts and image responses.

A provider HTTP error, timeout, missing image, or malformed response is saved as a terminal failure with a specific error code and a user-facing message. Messages distinguish daily free Workers AI quota exhaustion (10,000 neurons, resetting at 00:00 UTC), provider credit/quota limits, rate limits, credentials/permissions, model access, content rejection, invalid parameters, outages, connection failures, and image conversion failures. Provider HTTP status is included when available. The Worker classifies bounded provider error envelopes into curated messages; it never forwards raw provider text, keys, prompts, or internal diagnostics. The iOS client displays these structured messages and retains a generic fallback for malformed or unknown responses. Logs contain only status and error code.

Recovery returns the same HTTP 502 code/message, and repeating the same idempotency key does not invoke the provider again. Older saved failures without a specific code remain readable. The attempt still consumes its reserved account/global allowance because a provider may have performed billable work even when the response failed. Successful jobs keep their original image and metrics after routing changes. Reuse the original explicit model ID when retrying a POST; if the default changed since an omitted-model request, recover by `GET /v1/generations/{id}` instead. Registration, renewal, access reporting, and saved-image recovery remain available even if provider configuration is missing.

## Durable generation for interrupted phone connections

Clients sending `X-Coloring-API-Version: 2` reserve non-fal generations as durable alarm jobs and receive HTTP 202 immediately after validation, moderation, and reservation. The account stores the public model, resolved provider route, prompt, and dimensions until completion; it never stores provider credentials or binding objects. Alarms reconstruct the provider request using current credentials, generate up to three non-fal images per pass, store the PNG in R2, and complete the same generation ID. Redmond retains its existing fal alarm path. Legacy clients retain their synchronous non-fal responses.

Alarm retries never resubmit an ambiguous paid call. A persisted `submitting` marker becomes a terminal, explicitly uncertain failure after a restart. A `saving` marker can recover an already committed R2 image without repeating generation. Terminal jobs remove their queued prompt. Legacy synchronous jobs still processing after ten minutes become terminal timeout records instead of remaining unfinished indefinitely.

Offline tests cover disconnected three-image batches, object restart before execution, reconstructed multipart requests, credential-free job storage, ambiguous submissions, and R2/record handoff recovery. These tests use synthetic provider responses and do not generate paid images.

## Current deployment

On 5 October 2026, version `516aa78b-c26a-4080-814c-b23caf4145f0` was deployed with durable API-v2 generation. Deployment used `--keep-vars` with the existing Durable Object, R2, AI, and Images bindings and preserved service configuration and secrets. Offline Worker, moderation, and configuration checks passed. The matching iPhone app passed 58 simulator tests (5 deliberate skips), including gallery persistence, acknowledgement after local save, missing-job handling, and interrupted-batch restoration. Physical live generation during lock remains unverified.

Earlier deployment history:

Version `08be8ee2-6834-4f18-bd7d-e165fd5fcbd8` was deployed on 23 September 2026 from commit `18732b8`, including all eleven model routes, the latest provider error reporting, and existing cost estimates. Deployment used `--keep-vars` and retained the R2, Durable Object, and Images bindings. Live verification passed for registration, all eleven authenticated catalog entries and their upstream routes, account access with the full 1,000-image allowance intact, and HTTP 401 for unauthenticated catalog access. No paid generation was performed. Offline Worker, cost-estimate, and configuration tests passed; the merged iOS suite ran 34 tests with one intentional paid-test skip and zero failures.

### Earlier Gateway setup and verification

AI Gateway was enabled on 23 September 2026. Gateway `coloring-sheets` is in account `994f60c144bd9dd9bc2333bd3abba832`, with authentication enabled, BYOK required (`byok_only: true`), caching disabled, logging enabled, and one maximum request attempt. The Worker uses `AI_GATEWAY_KEY_SOURCE=worker` and its existing `OPENAI_API_KEY`; the Gateway receives the separate Run token. No OpenAI key was copied into Gateway's Provider Keys.

Worker code was deployed with `--keep-vars`; after storing the dedicated Workers AI secret, version `62935cb9-fe6d-41d9-8bb6-f4d970987122` was initially active at 100% (superseded by the current version above). The existing signing secret, provider key, R2/Durable Object bindings, 1,000-image account allowance, and 10,000-image global daily limit were preserved. OpenAI remains live. Both Cloudflare-hosted FLUX routes and the Images binding are deployed. With user approval, the existing Gateway Worker token was updated to Workers AI Edit, and a distinct “Coloring Sheets Workers AI” token was created from Cloudflare’s Workers AI template, scoped to this account, and stored as the encrypted WORKERS_AI_API_TOKEN secret. The temporary local copy was removed. Other providers still require their credentials and a model route.

Live verification passed for account access, model discovery, one OpenAI image through Gateway, and recovery of the identical saved PNG. The successful request used `gpt-image-2.5-flare`, returned a 1024 × 1456 PNG in about 11 seconds, and reported `viaGateway: true`, `provider: openai`, and 243 total tokens. The first verification attempt failed locally because Cloudflare's runtime rejects `redirect: "error"`; this was reproduced in local workerd and fixed using `redirect: "manual"` with non-2xx rejection. That first attempt never appeared in Gateway logs and consumed one reserved test allowance. The successful check consumed one further test allowance. Offline tests cover redirects and terminal failures as well as account and budget behavior.

### FLUX verification

Live checks passed on 23 September 2026 for both models through the deployed Worker, including JPEG-to-PNG conversion and recovery of the identical PNG from R2. Each successful generation used one account allowance; recovery used none. Both outputs were 1024 × 1456 and were visually inspected as black-outline coloring pages.

| Model | Worker duration | Gateway status | Cached | Gateway-reported inference cost |
| --- | --- | --- | --- | --- |
| FLUX.2 Klein 4B | 14.0 seconds | 200 | No | ¢0.162976 |
| FLUX.2 Klein 9B | 2.6 seconds | 200 | No | ¢1.584374 |

These are individual test observations, not latency guarantees or billing receipts. Images conversion and other Worker/storage usage are separate. The Gateway log IDs are `01M385NJAS2T7VNE4040G4C49F` (4B) and `01M385PNTVF10DQYSCJZ061CAB` (9B). Synthetic PNGs and metrics are saved locally in the Git-ignored `.build/flux-verification/` directory. Rebuild the iOS app to expose both FLUX options in Settings → Model; an already installed older build retains its original picker.

Offline Worker checks cover multipart formatting, separate credentials, size fitting, PNG conversion/pass-through, reservation limits, saved recovery, and terminal failures without provider retries. The actual local Cloudflare runtime also converted the real JPEG successfully. Simulator XCTest completed with 32 tests, one intentional live-test skip, and zero failures. The credential precheck was verified live to return HTTP 503 without spending allowance when the separate key is missing.

## Account renewal

`POST /v1/installations/renew` accepts `{}` with the saved bearer credential and returns a new 30-day access token for the same `accountId`. Only this endpoint accepts expired tokens: it still verifies the signature and checks the account’s current `credentialId`. It never creates a new account, resets allowance, spends credit, or invokes image generation. Credits and existing generation records remain attached to the account. Revoking its credential ID or rotating the signing secret blocks renewal as well as access.

The signed credential stored in the device Keychain provides long-term renewal access until revoked; the 30-day expiry limits direct API use, not the lifetime of the device identity. This supports already-expired credentials from existing app installations without discarding their accounts. The renewal endpoint was deployed on 23 September 2026 as version `742dc241-7c55-4c6c-afa7-b930011c790e`. That version was subsequently superseded by the AI Gateway deployment documented above. Offline tests cover expiry, retained credits/jobs, forged credentials, and revocation. The live renewal route returns its expected HTTP 401 JSON response for an invalid credential. Cloudflare blocks the default `Python-urllib/3.9` User-Agent with error 1010; curl and Python with an explicit `ColoringSheets-DeploymentCheck/1.0` User-Agent reach the Worker. This was isolated by changing only the User-Agent header in both clients. Use an explicit deployment-check identity for Python verification requests. An authenticated live renewal flow has not been exercised; the offline tests cover it.


## Z-Image Turbo on fal.ai

The `z-image-turbo` public model is available in the app picker and WonderLines Compare. It uses `fal-ai/z-image/turbo` through the existing AI Gateway fal proxy and `FAL_KEY`. No new provider account or key is needed. Preserve the dashboard-managed `FAL_DAILY_GENERATION_LIMIT`: it caps Z-Image and Redmond generations together, including comparison requests.

Each request generates one PNG at the requested dimensions using eight inference steps, the existing child-appropriate outline prompt and age/composition guidance, and the provider safety checker. Prompt expansion is explicitly disabled, avoiding its extra fee and changes to the supplied guidance. This addition does not resize or upscale outputs.

App and website requests share the existing durable fal submission, polling, idempotency, moderation, budget and saved-image recovery path. The comparison Worker builds a credential-free task; the production Account validates provider configuration before spending allowance. Submission uses `/fal-ai/z-image/turbo`; status/results use `/fal-ai/z-image/requests/{id}`. Provider-supplied URLs are never used for polling. Downloads retain the existing HTTPS fal CDN allowlist and PNG validation.

Pricing and billing lookups use the actual upstream endpoint, so Z-Image cannot inherit Redmond's compute-second price. Cost displays use verified billable units or a matching provider billing event; missing units remain unavailable rather than treating inference seconds as megapixels. The app's Usage view supports read-only fal billing refresh for both models. Public pricing checked 23 October 2026 is ¢0.5 per megapixel; final charges depend on provider billing units.

Validation: `node Scripts/test_z_image.mjs` exercises app/website admission, missing-credential rejection before spend, endpoint-specific payload/polling/billing, restart recovery without resubmission, safety rejection and shared fal limits with synthetic responses. Run it alongside the existing Worker and comparison tests. Rebuild the app and deploy both Workers with `--keep-vars` to expose the new choice. No paid inference is required by these checks.

Sources: [Z-Image schema](https://fal.ai/models/fal-ai/z-image/turbo/api), [queue URL structure](https://fal.ai/docs/documentation/model-apis/inference/queue), [pricing](https://fal.ai/models/fal-ai/z-image/turbo).

## ColoringBook.Redmond V2 on fal.ai

The twelfth picker choice is `coloringbook-redmond-v2` (Beta). Sunburst remains the app default. Its route is `{"provider":"fal","model":"coloringbook-redmond-v2"}`; the Worker resolves that preset to `fal-ai/lora`, using SDXL 1.0 plus the [Redmond V2 LoRA](https://huggingface.co/artificialguybr/ColoringBookRedmond-V2). Weights are pinned to revision `0e67e0de2b603db085e525e7f6194b24dc60033d`. The base model ID is fixed, but fal controls its runtime and base-model deployment; the adapter revision alone does not promise bit-for-bit reproducibility.

### Activate

1. Add `FAL_KEY` as a **secret** on the existing `coloring-sheets-api` Worker. Never add it to the app or Git. fal uses this Worker-held key independently of `AI_GATEWAY_KEY_SOURCE` for OpenAI/Google.
2. Retain `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `AI_GATEWAY_TOKEN`. The adapter uses Cloudflare's `/fal` provider proxy and `x-fal-target-url` to reach the fal queue. See [Cloudflare's integration](https://developers.cloudflare.com/ai-gateway/usage/providers/fal/).
3. Set the dashboard variable `FAL_DAILY_GENERATION_LIMIT` to an explicit trial allowance (current requested value: `1000`). This is a generation-count cap across all accounts, in addition to the existing global and personal allowances. `0` pauses new fal jobs; missing or malformed configuration rejects new fal requests before reserving allowance. It does not stop already submitted jobs. Other providers keep their existing limits. The cap resets at 00:00 UTC.
4. Run the offline checks, deploy the Worker with `--keep-vars`, then build/install the app. No binding or Durable Object migration is required: the existing Account objects now implement alarms.
5. Deliberately request **one** Redmond sheet first. Check the fal dashboard's actual charge and the output before running the comparison below. Missing price estimates do not mean free generation.

The preset sends one PNG per request, LoRA strength 1, 30 steps, guidance 7.5, safety checking enabled, and prompt weighting enabled to accommodate SDXL prompts longer than 77 tokens. It preserves the user's subject, age-complexity guidance and composition, adds `ColoringBookAF, Coloring Book`, and supplies a negative prompt for color, shading and text. Images are scaled to approximately one megapixel in 16-pixel increments; a 1456 × 1024 request becomes 1216 × 864. Smaller requests stay unchanged. These are initial evaluation settings, not validated quality recommendations. See the [fal schema](https://fal.ai/models/fal-ai/lora/api).

### Queued jobs and recovery

`POST /v1/generations` reserves one allowance and atomically saves the job and an alarm, returning HTTP 202. Account alarms submit up to five pending jobs per pass and persist each fal request ID. Later alarms poll the same IDs, fetch the result, validate and save the PNG in R2, and complete the existing job. Transient status/download/storage errors retry reads only, for up to 30 minutes. A process interruption during submission without a saved fal ID is terminal and explicitly uncertain; the Worker never resubmits it. Check fal usage before deliberately starting another generation. Gateway retries and cache reuse are disabled.

All queue URLs are constructed by the adapter. Image downloads accept only HTTPS `fal.media` hosts, reject redirects, carry no credentials, and are limited to 20 MiB. Unsafe output is rejected. Job payloads contain the prompt while processing and are removed from the account record when the job becomes terminal. Credentials are never stored in job records. The completed metrics include provider, endpoint, LoRA revision, seed, dimensions and timing. Cost reporting uses fal billing records when available, then reported billable units and live pricing, then a clearly labeled inference-time estimate for compute-second pricing. Wall-clock queue time is never used as billable compute time.

The app retains pending Redmond IDs, model choices and timestamps locally, scoped to the service URL and anonymous account. It retains no prompt or token in this recovery list. Foreground recovery makes up to 40 GET checks with 5–15 second backoff. **Stop waiting** stops app polling; the server can continue. **Check unfinished sheets** works after cancellation, backgrounding or relaunch, appends recovered sheets to the gallery, and never sends a generation POST. Local pending entries expire after 24 hours. Recovery needs the original anonymous account and a result still retained in R2. Older app versions retain their existing shorter polling behavior.

### Quality comparison before promoting the preset

After the first successful smoke test, compare these six subjects at ages 4 and 15 using Redmond, Sunburst, and the existing SDXL option: a friendly dinosaur on a bicycle; a butterfly beside three flowers; a cat in a space helmet; a castle beside a river; two children building a sandcastle; an underwater turtle with fish. That is 36 sheets with one image per request. Keep each subject, age guidance, composition and requested size the same across models. Record actual output size because each adapter has different native sizing.

Score each image for subject accuracy, enclosed coloring areas, unwanted shading, age suitability and print quality. Record latency, actual provider charges, and cost per usable sheet. Reuse fixed seeds for later Redmond-only parameter experiments where supported; the app currently lets fal choose and report the seed. Do not automatically regenerate rejected or failed images. Compare strength 0.8 versus 1.0 only as a separate, budgeted preset experiment. Keep the default unchanged until the results justify a change.

Offline tests cover alarm completion after a fresh Account instance, ambiguous submission, queue delays, download retries, unsafe output, untrusted URLs, redirected downloads, concurrent budget reservations, missing credentials, and saved-image replay. iOS tests cover relaunch recovery with one paid POST, extended polling, account isolation, expiry and gallery preservation.


### Live verification — 24 September 2026

Deployed Worker version `400f7307-17bc-4cc4-b68b-dae30c53dba5` with `FAL_DAILY_GENERATION_LIMIT=1000`. Read back the deployed version to confirm that limit, the `FAL_KEY` secret binding, and the existing Gateway configuration. The independent global daily cap remains `10000`.

One explicit Redmond generation succeeded through the public authenticated API: requested 1456 × 1024, returned a valid 1216 × 864 PNG (1,578,797 bytes), 28.519 seconds end-to-end and approximately 11.765 seconds reported inference time. The result showed the requested dinosaur on a bicycle with black outlines, but added flowers and fine details beyond the simple prompt. It remains Beta; the 36-sheet quality comparison has not been run. fal did not supply a usable seed or billing amount in the recovered result, so neither is invented. Local, Git-ignored verification artifacts are under `.build/fal-live/`; the private recovery state includes the temporary anonymous test credential and must not be shared.

Validation also passed the mocked Worker suite, configuration checks, 40 offline iOS/UI tests (two additional paid tests skipped), and a local workerd test using real SQLite Durable Object transactions, alarm delivery and R2 storage with mocked upstream calls. The two final recovery regression tests were rerun successfully after the gallery/configuration cleanup.


## fal cost logging and reconciliation

For each fal submission, the Worker logs `fal_submitted` with the generation ID and fal request ID. On completion or failure it saves a `.usage.json` ledger entry beside the image in R2 and emits a structured `fal_usage` log. Worker observability is enabled. Entries include the IDs, state/error code, model/revision, requested/actual dimensions where available, image count, steps, inference and total times, billable units, unit rate, lookup status and cost evidence. Prompts, provider keys, access tokens and raw provider errors are excluded. Reconciliation overwrites the same ledger object; it is not a second billable generation or a second charge to sum.

The Worker checks [fal pricing](https://fal.ai/docs/platform-apis/v1/models/pricing) and [billing events](https://fal.ai/docs/platform-apis/v1/models/billing-events) using read-only, bounded requests:

1. An exact matching billing event supplies the provider-reported cost after discounts (`costEvidence=billing_event`).
2. Otherwise, `x-fal-billable-units` from the result response multiplied by verified USD unit pricing supplies an estimate (`costEvidence=billable_units`).
3. If the billable count is absent and the verified unit is specifically compute seconds, inference duration × unit price provides an **inference-time proxy** (`costEvidence=inference_time_proxy`). Model loading and other billed overhead can increase the actual charge. Total elapsed/queue time is never substituted for inference time.
4. Missing or malformed evidence remains unavailable, never implicitly zero. An unavailable billing API does not prevent image delivery.

`GET /v1/generations/{id}/usage` requires the original account credential and returns that account's saved metrics. It can refresh incomplete costs after 60 seconds, including older saved fal jobs, without sending a generation POST. The app refreshes this endpoint when opening Usage for a Redmond sheet; pull to refresh checks again. A verified reported charge is retained. Saved image recovery returns the enriched metrics too. The existing `estimatedTotalUsd` field remains compatible with older app versions; `costStatus` distinguishes reported costs from estimates.

Live checks on 24 September 2026 confirmed pricing of **¢0.125 per compute second** for `fal-ai/lora`. The current key receives HTTP 403 from the billing-events API, and the earlier test's result had no billable-units header. Its recorded 11.765 inference seconds therefore supports an estimate of **¢1.470625**, excluding unknown billed overhead. That is an estimate, not a billing receipt. A key with billing access would allow later reconciliation to the provider-reported charge; no broader key permissions are needed to keep generating sheets or collecting inference-based estimates.


Cost logging was deployed as Worker version `befa6992-3a19-47ae-b700-c8066a0fdcc6`. A read-only live recovery of the original Redmond test returned HTTP 200 with `costStatus=estimated`, `costEvidence=inference_time_proxy`, the verified rate, and `¢1.4706249833106994` estimated cost. No additional image was generated to validate billing. The 1,000-sheet fal cap was preserved.

The live Wonder Lines build with cost reporting was signed using the existing development team and installed on the connected iPhone 17 Pro (J17) on 24 September 2026. The install preserved bundle identifier `com.jordan.family.ColoringSheets` and the current Wonder Lines branding. After the phone was unlocked, devicectl confirmed that the app launched successfully. Worker/configuration tests and the iOS unit suite passed before installation.

Signing fix (4 October 2026): Apple assertion creation uses a process-wide FIFO permit shared by all `AppAttestClient` instances. The permit remains held across suspension until signing and its diagnostic event finish, and releases on success, error, or cancellation. A cancelled queued caller skips signing when its permit arrives. Challenge requests and image-generation POSTs remain parallel. The live concurrency comparison now asserts that all three concurrent callers pass.

Verification of the signing fix on iPhone J17 at 11:33 London time on 4 October 2026 passed all six sequential and all three concurrent empty-body requests (`sequential=6/6; concurrent=3/3`). Both the device test build and Release build passed. The verified Release app was installed on the device; no paid image generation was used.

Diagnostic logging update: client reports retain at most 300 events for seven days, condense unchanged recovery polls, and correlate batch lifecycle and cancellation with request events. Routine persistence is grouped over one second; errors, terminal summaries, and backgrounding flush immediately. The server correlation update requires deploying this Worker source; app-only installation does not change deployed Worker logs.

Original-description batch update verified on 4 October 2026: 42 app tests passed, five opt-in/device-specific tests skipped; Worker, batch moderation, and configuration tests passed without live image generation. The Worker was deployed with `--keep-vars` as version `e60f770c-ffe3-423d-8f2d-b24cf5c977a7`, and the corresponding signed Release app was installed on the connected iPhone.

Moderation diagnostics deployed on 4 October 2026 as Worker version `3107790b-f11a-4128-802d-09ad261e76f5` using `--keep-vars`. Worker logs now include the submitted moderation description and all seven validated scores for approvals and policy rejections; unavailable checks include the description without scores. Batch, Worker/moderation, and configuration checks passed offline.

Moderation model selection: set the server variable `MODERATION_MODEL` to `jev`, `clef` (default), or `clef-flash`, or the corresponding full Workers AI model ID. Clef uses `@cf/cloudflare/clef`; Clef-flash uses `@cf/cloudflare/clef-flash`. The same questions, validation, thresholds, timeout and Gateway logging settings apply. Invalid model configuration fails closed. Model selection is included in the batch cache fingerprint; clients cannot select moderation models. Switching models requires evaluating the complete policy corpus.

For a live text-only comparison, run `node Scripts/compare_moderation.mjs --live --description="ferrari racing a dog with a smile"` with Wrangler installed and authenticated. `WRANGLER_MODULE` can identify an existing Wrangler installation; `MODERATION_PROXY_CONFIG` can identify a minimal config with an AI remote binding. It runs one billed request per model and prints validated scores, decisions and elapsed times, without generating images or exposing raw responses.

Local policy `all-ages-v2` narrows the bypass instructions and both answer criteria to explicit manipulation of moderation, trusted-instruction impersonation, or concealment/decoding intended to evade checks. Unsuitable subject matter alone is assessed by the content hazards. Thresholds and the common context are unchanged. The 4 October 2026 Ferrari comparison is saved in `docs/moderation/2026-10-04-narrowed-bypass-comparison.json`: bypass scores fell from 0.08/0.0777/0.1455 to 0.03/0.0566/0.0387 for Jev/Clef/Clef-flash respectively. All three still rejected under the existing thresholds. This revision has not been deployed or validated on the complete live policy corpus.

Policy `all-ages-v3` raises the safety-bypass probability limit to 0.10 (inclusive), retaining the narrowed v2 definition. Overall suitability still requires 0.95, violence permits up to 0.10, and sexual, hate, adult and frightening scores permit up to 0.05. The v3 policy passed all 34 existing live Jev policy cases before main integration. All three recorded v2 Ferrari evaluations now pass the bypass check but still fail overall suitability.

Clef-flash switch validation on 4 October 2026: all 23 unsuitable cases were rejected, but all 11 harmless cases were also rejected using the existing thresholds. Full validated scores are saved in `docs/moderation/2026-10-04-clef-flash-policy-corpus.json`. This baseline motivated the subsequent v4 calibration. Server and GitHub deployment configuration explicitly select `MODERATION_MODEL=clef-flash`; Jev and Clef remain selectable for comparisons.

Clef-flash calibration on 4 October 2026: policy `all-ages-v4` passed all 74 live cases (31 harmless scenes approved, 43 unsuitable or bypass cases rejected) through the `coloring-sheets` gateway. This includes the Ferrari/dog and dinosaur/pasta regressions, neutral fantasy characters, medicine, affection, multilingual prompts, explicit and obfuscated hazards, and bypass-only instructions. Scores are saved in `docs/moderation/2026-10-04-clef-flash-calibrated-validation.json`. This sample does not guarantee arbitrary prompts. Worker, batch moderation, configuration, and all model threshold boundary checks passed offline. The signed Release app was rebuilt and installed on the connected iPhone 17 Pro and ninth-generation iPad; all 19 simulator GenerationTests passed.

Policy `all-ages-v5` selects Clef (`@cf/cloudflare/clef`) as the production default. Jev and Clef permit frightening scores up to 0.25 and violence scores up to 0.20, inclusive; their overall suitability remains at least 0.95, sexual/hate/adult at most 0.05, and bypass at most 0.10. Clef-flash retains its separate v4 thresholds for comparisons. Gateway logging remains enabled. All offline Worker, batch, configuration and per-model boundary tests passed. The 74-case live Clef run rejected all 43 unsuitable/bypass cases but also rejected 25 of 31 harmless cases; it passed 49/74 overall. The remaining false positives are recorded rather than silently relaxing other thresholds. Full scores are saved in `docs/moderation/2026-10-04-clef-v5-validation.json`. No app rebuild is required for the server model switch.

Recovery review deployed on 5 October 2026 as Worker version `8faedd0b-f29c-4b51-a40b-2a84f2a22fe5` using `--keep-vars`, verified active at 100%. Completed jobs are now persisted before optional fal billing lookups, allowing image recovery while those lookups wait. The early completed record removes the saved prompt, and billing enrichment still updates metrics afterward. An offline public-API test stalls billing and verifies HTTP 200 for the saved image with no additional generation. Worker, batch moderation and configuration checks passed. The accompanying iPhone build replaces in-flight recovery GETs on foreground without touching submission POSTs; 64 app tests completed with five skipped and no failures. Installed on J17; opening was blocked by the device lock.

Follow-up review on 5 October 2026 deployed Worker version `5db80224-6a5a-4b97-a092-ba4f609240b9` with `--keep-vars`, verified active at 100%. Completion and concurrent usage reads share one billing update per job, preventing duplicate lookups and competing metadata writes. The offline regression test verifies one pricing/billing lookup pair and matching returned/stored metrics while image recovery remains available. The app also clears all saved recovery IDs after a successful snapshot or relaunch, including a prior failed-save handoff, and removes obsolete save warnings. All 66 app tests completed with five skips and no failures; Worker, batch moderation and configuration checks passed. The live iPhone build was installed and launched successfully on J17; no paid generation was started during this follow-up verification.

Policy `all-ages-v7` (6 October 2026) raises every content limit below 30% to 30% across Jev, Clef and Clef-flash. Higher limits and minimum overall suitability scores are preserved. The policy revision changes the batch cache fingerprint, and the moderation lab imports these same limits. This threshold change has been checked offline; earlier live calibration results describe their original policy revisions.

Clef permissive calibration (6 October 2026): policy `all-ages-v8` lowers minimum overall suitability from 73% to 40%. Maximum scores are sexual 65%, violence 45%, hate 50%, adult 60%, frightening 50%, bypass 60%. Jev and Clef-flash keep their v7 profiles. This threshold-only change approved 137/139 labelled harmless evaluations versus 115/139 for v7, with all 125 labelled unsafe evaluations rejected. The harmless count includes six repeated BMW/Bugatti regression checks; without repeats, 131/133 harmless cases passed. Remaining harmless rejections are a robot using a punching bag and ordinary bikini swimwear. A broader discarded profile allowed “A smiling person kicking a dog” and unclear gibberish. Scores are model outputs, not calibrated probabilities; recorded results do not guarantee future behavior. Full scores, approved descriptions, rejected descriptions, and profile comparisons are in `docs/moderation/2026-10-06-clef-permissive-report.json`. Reproduce the analysis with `node Scripts/report_permissive_calibration.mjs`. Live scoring is opt-in via `Scripts/evaluate_moderation_corpus.mjs` and Wrangler's remote AI binding.


Build 7 reporting and privacy update (17 October 2026)

Delayed fal billing now transactionally merges only metrics into the current job,
preserving reported-sheet blocks. Reporting likewise preserves newer billing
metadata. The offline reporting-concurrency regression covers the original race
and concurrent deletion.

Report handling is assigned to Jordan Erenrich, with a daily Codex metadata-only
queue check and notification for new or overdue reports. See
`docs/app-store/2026-10-17/build7-report-operations.txt`. The operator must inspect
and act on reports; the monitor never moderates or deletes user content.

Build 7 release model decision: an explicit Redmond live check on 17 October
returned HTTP502 after about two minutes. Its temporary test account was deleted.
Redmond is excluded from the build7 picker until provider reliability is verified.
It remains decodable for existing sheets/recovery and the backend reporting fix
also applies to those older jobs. No paid retry was attempted.

## Comparison studio execution

`COMPARISON_ACCOUNT_ID` identifies the private comparison studio account. Only this account uses up to 50 independent `ComparisonImageRunner` Durable Objects via `COMPARISON_RUNNERS`. Reservations, moderation, idempotency and daily/global budgets remain in Account/Budget. Each image handoff returns promptly; its runner alarm performs inference and reports the saved result back to Account. Stable, durable slot ownership prevents late UUIDs or overlapping watchdogs from exceeding 50 active tasks. Ordinary app accounts retain their existing three-image queue. `v2-comparison-image-runners` provisions the runner namespace; retain it in subsequent deployments. Runners never automatically repeat an ambiguous provider submission and retain only a compact idempotency receipt after completion. Tests: `node Scripts/test_comparison_queue.mjs` and `node Scripts/test_comparison_runner.mjs`.

### Image retention

The shared `coloring-sheets-generations` bucket must not have a bucket-wide object-expiration rule. The hourly service sweep expires ordinary app recovery PNGs after 24 hours and explicitly exempts `COMPARISON_ACCOUNT_ID`; missing/invalid account configuration stops the sweep before deletion. Comparison images stay until their whole grid is evicted by the comparison library’s 2,500-image capacity. In-flight evictions wait for completion before deleting the file. The bucket’s multipart-upload abort rule remains enabled. Run `node Scripts/test_image_retention.mjs` and `node workers/generation-lab/tests/library.mjs` for retention coverage.
