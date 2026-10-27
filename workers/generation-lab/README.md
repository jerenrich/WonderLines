# WonderLines Compare

Private colouring-sheet comparison studio, hosted as the separate Cloudflare Worker `wonderlines-compare`.

Enter the key in the ignored `.secrets/generation-lab-access-key` file. Select a prompt, one or more models, and ages 3–18. **Select all** enables every available model, including those under **More models**. A run generates the model × age combinations (up to 80 sheets in the interface). Five models match the app's selectable picker; the remaining alternatives are under **More models**. All four age presets are selected by default, using representative ages 4, 7, 10 and 15; **Choose exact ages** selects any age from 3–18. With 24 models, selecting all four ages exceeds the existing 80-sheet limit; choose fewer models or ages. The compact grid shows images without footer panels. Click an image to enlarge it, or its top-right **i** button for generation details, costs, and recovery actions. Export comparison metadata as JSON. The toolbar totals known image inference estimates (with a count when estimates are incomplete). Beneath each model, the mean elapsed time uses its completed images with timing metadata, including queue time.

## Foundation model coverage (2026-10-27)

The comparison catalogue extends the existing app catalogue without adding new choices to the iOS app. All additions use the existing production `FAL_KEY`, AI Gateway fal proxy, private R2 bucket, moderation, and daily fal/global budgets. No new provider account, GPU deployment or copied credentials is required. Hosted fal pricing applies; the earlier self-hosting GPU estimates are not endpoint prices.

| Models | Existing provider / endpoint |
| --- | --- |
| Klein 4B / 9B, SDXL Base / Lightning | Already available through Workers AI |
| Z-Image Base / Turbo | `fal-ai/z-image/base`, `fal-ai/z-image/turbo` |
| SANA / SANA-Sprint | `fal-ai/sana`, `fal-ai/sana/sprint` |
| ERNIE-Image / Turbo | `fal-ai/ernie-image`, `fal-ai/ernie-image/turbo` |
| Lumina-Image 2.0 | `fal-ai/lumina-image/v2` |
| Krea 2 Turbo | `fal-ai/krea-2/turbo` (open-weight family, not the separate Medium/Large API) |
| Klein Base 4B / 9B | `fal-ai/flux-2/klein/4b/base`, `fal-ai/flux-2/klein/9b/base` |
| Qwen-Image / 2512 | `fal-ai/qwen-image`, `fal-ai/qwen-image-2512` |
| ColoringBook Redmond V2 | Existing pinned SDXL LoRA preset, now also available in Compare |

SANA endpoint IDs do not expose independent 0.6B/1.6B checkpoint selection; the options are labelled by the hosted model rather than promising an exact weight revision. Selecting specific checkpoints or arbitrary LoRAs would require a separate integration. Krea RAW, Chroma1, Flex.2-preview and Qwen-Image-2.1 Turbo are listed under **Models requiring another endpoint** and cannot be selected. No verified matching hosted endpoint was found in the current integrations. Qwen 2.1 Turbo can use Alibaba Cloud with another integration; the others can use a custom GPU deployment, including fal Serverless if the account has deployment access. Qwen 2.1's downloadable weights require separate commercial licensing.

Each new fal preset uses the provider's documented parameters, one image, a PNG output and the provider safety checker. Optional prompt expansion is disabled to preserve the comparison prompt. fal outputs are fitted to approximately one megapixel while retaining the requested aspect ratio; the actual output dimensions are recorded in image details. Inference steps are explicit except Krea Turbo, whose endpoint controls its sampling schedule.

Comparison fal jobs use the independent durable image runner: submit once, save the provider request ID, then poll via alarms. Queue result/status URLs use only `owner/app`, not the endpoint subpath. Restarted runners and transient download failures recover the same request; ambiguous submissions are never automatically repeated. Read-only billing lookups use the actual model endpoint and exact request ID. Missing provider evidence remains an unavailable estimate, never a zero cost. The existing iOS Redmond queue and billing path remain supported.

Endpoint schemas: each endpoint's `https://fal.ai/models/<endpoint>/api` page. Queue protocol: https://docs.fal.ai/model-apis/model-endpoints/queue.

## Generation and recovery

The Worker binds to the existing production `coloring-sheets-api` Account Durable Object and image bucket. A dedicated lab account shares production moderation, generation queue, provider credentials, cost metadata, and the global spend ledger. Its own 100-sheet daily allowance is separate from iPad accounts. The app API and studio share `coloring-sheets-api/src/generation-start.mjs` for request validation, prompt composition, recovery, moderation and job reservation. The app’s App Attest policy remains unchanged. The lab is a trusted server client of the internal account interface; its public routes expose only bounded lab operations. Never expose arbitrary Durable Object paths or object keys.

All server-side providers run inside the production Account object, so image provider keys never need to be copied to this Worker. The model catalogue imports the production source defaults; if production adds `IMAGE_MODEL_ROUTES` overrides, keep this Worker's non-secret catalogue overrides aligned. The initially inspected live deployment had no routing overrides.

Images are queued with idempotent IDs and survive browser disconnection. The client submits and watches up to 50 at a time. The production Account coordinator assigns at most 50 durable execution slots specifically to the comparison account. Each image runs in its own `ComparisonImageRunner` alarm with its own outgoing-connection context; a slow provider does not hold up all other models. The usual iPad accounts keep their three-image execution limit. Model timeouts begin inside each runner when inference starts. `queueMs` and `inferenceMs` are included in image details. Library reads/status responses bypass the generation mutation queue, unchanged polls do not rewrite grid/index records, and browser updates are coalesced to animation frames. Every prompt, model/age layout and generation state is now saved in a Cloudflare SQLite Durable Object before the browser starts its image requests. The **Library** view searches and opens saved grids across browsers using the same access key. The newest 100 grids are retained by original creation time. Inserting grid 101 atomically removes the oldest grid from the index and tombstones its IDs; a durable alarm deletes only that lab grid's images from R2. If a retired image is still running, cleanup waits for its terminal job status before deletion. Tombstones stop old tabs from recreating evicted grids. The old browser-local history (up to eight grids) is imported automatically when that browser next unlocks the workspace; only matching server jobs supply its saved statuses and costs. Browsing a saved comparison never starts queued images automatically; **Resume generation** is explicit. **Check / resume** uses the same ID after a connection failure. Failed tiles have a visible **Retry image** button, and **Retry failed images** retries the failed cells together. Retries first reconcile the old job: completed or in-flight images keep their IDs, confirmed failures get a new ID, and a failed status check never submits a new request. Successful sibling images remain unchanged. Already submitted images continue drawing when the workspace is locked. Image retrieval always requires a valid session and resolves only within the lab account. Images remain in the existing private production bucket while their grid is retained. The library alarm reconciles submitted jobs even when all browsers are closed. The production account job ledger is retained for idempotency; eviction removes the browsable grid and its image objects. No automatic generation requests are retried with a new ID.

## Access

`src/auth.mjs` owns access-key login and returns a principal to the generation handlers. **Remember me** issues a signed 30-day `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` cookie. Unchecked sessions are browser-session cookies with a maximum signed lifetime of 12 hours. The access key never goes into client storage or URLs. Key rotation invalidates existing sessions. **Lock workspace** clears the browser cookie; previously copied bearer cookies remain valid until expiration or key rotation. Mutating routes require the exact same Origin. Login attempts are limited per Cloudflare-supplied IP; generation starts share an 80-per-minute limiter plus the serialized production account/global daily budgets. Cloudflare rate limiting is per location, not a strict global limit. Workers Logs are enabled for this Worker and the production API. Structured `comparison_image` events record admission, provider submission, terminal outcome, reporting, and persistence retries. Failures retain their stage, timing, HTTP status, bounded numeric/known provider error codes, safe provider/Gateway request IDs, Cloudflare ray, and Retry-After when available. These fields and the error code are also saved with the grid and shown under **i**. `comparison_start_failed` covers pre-inference failures; `comparison_library_unavailable` identifies storage/coordination failures. Logs never include descriptions, images, access keys, raw provider responses, request headers or arbitrary exception text. Gateway prompt/image collection remains disabled. Operational logs use the existing native seven-day retention; job metadata remains with the idempotency ledger. Historical jobs cannot recover metadata that was never recorded.

The repository Worker workflow tests and deploys this studio after the production API. Existing secrets and dashboard variables are preserved.

## Next: Google accounts

Google sign-in is not enabled in this version. Add Google OAuth authorization-code flow with PKCE and validated state/nonce, register the deployed HTTPS callback URL in a Google Cloud web OAuth client, and keep the client secret server-side. Validate ID token issuer, signature, audience and expiry; use the stable Google `sub` as the identity. Replace `getPrincipal` with a session-backed principal, explicitly allowlist approved accounts, and decide whether each user gets a separate Account namespace identity. Decide how the shared library should migrate before switching identities; it currently belongs to the shared lab account. Generation routes already consume a principal instead of the shared key.

## Check and deploy

From this directory:

```sh
node tests/worker.mjs
node tests/library.mjs
node tests/fal.mjs
npx wrangler deploy --dry-run
npx wrangler secret put LAB_ACCESS_KEY
npx wrangler deploy --keep-vars
```

For local work, use ignored `.dev.vars` with `LAB_ACCESS_KEY`. The actual cross-script Account binding requires Cloudflare deployment; offline tests replace it with a stub. `v1-comparison-library` provisions the new SQLite Durable Object namespace on first deployment. Keep the migration and namespace binding in future deployments. Do not add a production service binding or disable App Attest to make local generation work.
