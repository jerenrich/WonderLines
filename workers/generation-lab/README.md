# WonderLines Compare

Private colouring-sheet comparison studio, hosted as the separate Cloudflare Worker `wonderlines-compare`.

Sign in with the authorized Google account. Select a prompt, one or more models, and ages 3–18. **Select all** enables every available model, including those under **More models**. A run generates the model × age combinations (up to 80 sheets in the interface). Six models match the app's selectable picker, including Z-Image Turbo; the remaining alternatives are under **More models**. All four age presets are selected by default, using representative ages 4, 7, 10 and 15; **Choose exact ages** selects any age from 3–18. With 24 models, selecting all four ages exceeds the existing 80-sheet limit; choose fewer models or ages. The compact grid shows images without footer panels. Click an image to enlarge it, or its top-right **i** button for generation details, costs, and recovery actions. Export comparison metadata as JSON. The toolbar totals known image inference estimates (with a count when estimates are incomplete). Beneath each model, the mean elapsed time uses its completed images with timing metadata, including queue time.

Provider failure diagnostics now include `upstreamErrorReasons` (fixed cause categories), `upstreamErrorParameters` (known parameter names only), and `upstreamErrorDetailStatus` (`classified`, `unclassified`, or `unavailable`). Raw error messages, echoed input, credentials and image data are never retained, including hashes of provider messages. Classification identifies provider-reported symptoms, not independently verified root causes. Unknown wording remains explicitly unclassified. Image failures, persistence retries, failed starts and library outages use error-level logs, so query `outcome = "failed"` or the error-level view. The same safe fields persist with comparison jobs and appear in image details. This does not enable Gateway payload logging or retry inference.

## Foundation model coverage (2026-10-27)

The comparison catalogue extends the app catalogue. Z-Image Turbo is also available in the iOS app; the other additional fal presets remain comparison-only. All additions use the existing production `FAL_KEY`, AI Gateway fal proxy, private R2 bucket, moderation, and daily fal/global budgets. No new provider account, GPU deployment or copied credentials is required. Hosted fal pricing applies; the earlier self-hosting GPU estimates are not endpoint prices.

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

The Worker binds to the existing production `coloring-sheets-api` Account Durable Object and image bucket. A dedicated lab account shares production moderation, generation queue, provider credentials, cost metadata, and the global spend ledger. Its own 1,000-sheet daily allowance resets at midnight UTC and is separate from the unchanged 100-sheet iPad allowance. The production Account identifies it by `COMPARISON_ACCOUNT_ID`; both its displayed free allowance and hard daily cap are 1,000. Shared fal and global service budgets still apply. The app API and studio share `coloring-sheets-api/src/generation-start.mjs` for request validation, prompt composition, recovery, moderation and job reservation. The app’s App Attest policy remains unchanged. The lab is a trusted server client of the internal account interface; its public routes expose only bounded lab operations. Never expose arbitrary Durable Object paths or object keys.

All server-side providers run inside the production Account object, so image provider keys never need to be copied to this Worker. The model catalogue imports the production source defaults; if production adds `IMAGE_MODEL_ROUTES` overrides, keep this Worker's non-secret catalogue overrides aligned. The initially inspected live deployment had no routing overrides.

Images are queued with idempotent IDs and survive browser disconnection. The client submits and watches up to 50 at a time. The production Account coordinator assigns at most 50 durable execution slots specifically to the comparison account. Each image runs in its own `ComparisonImageRunner` alarm with its own outgoing-connection context; a slow provider does not hold up all other models. The usual iPad accounts keep their three-image execution limit. Z-Image Turbo uses the shared durable fal queue, processing up to five pending fal jobs per alarm, with the same provider credentials and shared fal daily cap as existing Redmond jobs. Model timeouts begin inside each runner when inference starts. `queueMs` and `inferenceMs` are included in image details. Library reads/status responses bypass the generation mutation queue, unchanged polls do not rewrite grid/index records, and browser updates are coalesced to animation frames. Every prompt, model/age layout and generation state is now saved in a Cloudflare SQLite Durable Object before the browser starts its image requests. The **Library** view searches and opens saved grids across browsers using the authorized Google account. The newest whole grids are retained by original creation time within the existing 100-grid limit and a 2,500-image-slot limit (including queued and failed slots). New grids and additions from older tabs atomically evict as many oldest grids as necessary and tombstone their IDs; a durable alarm deletes only that lab grid's images from R2. If a retired image is still running, cleanup waits for its terminal job status before deletion. Tombstones stop old tabs from recreating evicted grids. The old browser-local history (up to eight grids) is imported automatically when that browser next unlocks the workspace; only matching server jobs supply its saved statuses and costs. Browsing a saved comparison never starts queued images automatically; **Resume generation** is explicit. **Check / resume** uses the same ID after a connection failure. Failed tiles have a visible **Retry image** button, and **Retry failed images** retries the failed cells together. Retries first reconcile the old job: completed or in-flight images keep their IDs, confirmed failures get a new ID, and a failed status check never submits a new request. Successful sibling images remain unchanged. Already submitted images continue drawing when the workspace is locked. Image retrieval always requires a valid session and resolves only within the lab account. Images remain in the existing private production bucket while their grid is retained. The bucket has no age-based object deletion: hourly app-recovery cleanup skips the comparison account, and comparison eviction alone deletes its images. Existing libraries are trimmed to the image limit on first access after deployment. The library alarm reconciles submitted jobs even when all browsers are closed. The production account job ledger is retained for idempotency; eviction removes the browsable grid and its image objects. No automatic generation requests are retried with a new ID.

## Access

Comparison uses the same Google OAuth client and verified-email allowlist as model administration, with one shared eight-hour signed `HttpOnly`, `Secure`, `SameSite=Strict` session cookie. Signing out of either section signs out of both. The allowed Google identity maps to the existing shared comparison account and library; existing access-key sessions no longer grant access. Rotating the session secret invalidates both session types. Mutating routes require the exact same Origin. Login attempts are limited per Cloudflare-supplied IP; generation starts share an 80-per-minute limiter plus the serialized production account/global daily budgets. Cloudflare rate limiting is per location, not a strict global limit. Workers Logs are enabled for this Worker and the production API. Structured `comparison_image` events record admission, provider submission, terminal outcome, reporting, and persistence retries. Failures retain their stage, timing, HTTP status, bounded numeric/known provider error codes, safe provider/Gateway request IDs, Cloudflare ray, and Retry-After when available. These fields and the error code are also saved with the grid and shown under **i**. `comparison_start_failed` covers pre-inference failures; `comparison_library_unavailable` identifies storage/coordination failures. Logs never include descriptions, images, access keys, raw provider responses, request headers or arbitrary exception text. Gateway prompt/image collection remains disabled. Operational logs use the existing native seven-day retention; job metadata remains with the idempotency ledger. Historical jobs cannot recover metadata that was never recorded.

The repository Worker workflow tests and deploys this studio after the production API. Existing secrets and dashboard variables are preserved.

## Next: Google accounts

Google sign-in for the comparison workspace uses the existing OAuth callback and client. The signed OAuth flow records which section initiated sign-in, so the callback returns to the appropriate page without accepting arbitrary redirect URLs.

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

For local Google sign-in, configure the OAuth credentials and an appropriate HTTPS origin. The actual cross-script Account binding requires Cloudflare deployment; offline tests replace it with a stub. `v1-comparison-library` provisions the new SQLite Durable Object namespace on first deployment. Keep the migration and namespace binding in future deployments. Do not add a production service binding or disable App Attest to make local generation work.

Prices throughout the studio, detail dialogs and JSON exports use US cents (¢). API/storage metrics remain USD; exported monetary fields are renamed `*Cents` and tagged `priceUnit: "US cents"`. All displayed amounts use exactly two decimal places; nonzero costs below one hundredth of a cent display as `<¢0.01`, while genuine zero inference prices display as `¢0.00`. Run `node tests/cost-display.mjs` for conversion, historical explanation and export checks.

Comparison presets without matching audited price evidence show **Price unavailable**. This includes the approximately one-megapixel fal presets; the app’s audited Z-Image Turbo preset uses different dimensions, so its billing-confirmed reference is not copied to the comparison preset. Completed images can still show their own endpoint-specific billing evidence.

Each model choice and comparison row shows a per-image reference cost and either **Billing confirmed** or **Estimate**. The app uses the same audited reference prices. OpenAI figures are token-based averages; Cloudflare prices are metering-backed estimates for the stated presets; Z-Image’s reference price is backed by four matched billing events. These labels describe the reference samples, not a guarantee for future requests. Current route identity must match before a historical row is given a reference price. Run `node tests/model-reference-cost.mjs` to check every model and alias remapping.

The comparison picker and library use the KV-backed catalogue used for generation admission. Enabled comparison-only fal presets remain available when fal is enabled. An open comparison page refreshes its picker when it becomes visible, every 60 seconds while idle, and before starting a comparison. Stale selections are removed.

Admin drafts and change notes are saved in browser session storage for the current tab. After reauthentication or reload, an unchanged base version is restored automatically. If the published catalogue has changed, the recovered draft remains visible but cannot be published; copy its changes and discard it before editing the new version. Shared-session sign-out notifies other open tabs.

## Google-protected model administration

Model controls live at **`https://wonderlines-compare.jordan-erenrich.workers.dev/admin/models`**. They share Google sign-in with the comparison studio. Only the verified Google account **`jordan.erenrich@gmail.com`** has `models:read`, `models:write` and `models:rollback` permissions. Other Google accounts and unverified email claims cannot access the admin APIs.

### One-time Google setup

Production Google sign-in was configured and verified on **31 October 2026**. The **WonderLines Admin** web client belongs to **My First Project** (`brave-framework-465820-u0`). Its External audience remains in Testing with `jordan.erenrich@gmail.com` as the sole test user. The client ID, client secret and admin session secret are configured as comparison Worker secrets; no credential file is kept in this repository. A real Google sign-in loaded the live catalogue and change history successfully.

For a replacement client or another deployment, follow these setup steps. Until all required secrets are present, the page displays a setup message and admin APIs stay locked.

1. Create or select a Google Cloud project. Configure its Google Auth Platform branding and choose an External audience for this Gmail account. If the app is in testing mode, add `jordan.erenrich@gmail.com` as a test user.
2. Create an OAuth client of type **Web application**. Register this exact authorized redirect URI:

   ```text
   https://wonderlines-compare.jordan-erenrich.workers.dev/api/admin/auth/callback
   ```

3. From the repository root, configure the resulting client ID and secret on the **comparison studio Worker**, using interactive secret input. Do not paste secrets into chat, source code or command arguments:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID --config workers/generation-lab/wrangler.jsonc
   npx wrangler secret put GOOGLE_CLIENT_SECRET --config workers/generation-lab/wrangler.jsonc
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put MODEL_ADMIN_SESSION_SECRET --config workers/generation-lab/wrangler.jsonc
   ```

4. Keep `MODEL_ADMIN_ORIGIN` equal to the HTTPS origin in `wrangler.jsonc`. If adding a custom domain, update this value and the registered Google redirect URI together. Deploy with `--keep-vars` through the existing workflow, then open Model controls and sign in with the allowed account.

Only the `openid email` scopes are requested. The server uses authorization code flow with PKCE, signed expiring state, a nonce and `jose` verification of Google's RS256 ID token, issuer, audience, expiry and verified email. The Google subject is retained as the stable audit identity. Google access/refresh tokens are never stored. Admin sessions are signed, expire after eight hours and use an HttpOnly, Secure, SameSite=Strict cookie; rotating the session secret invalidates them. The short-lived OAuth round-trip cookie is SameSite=Lax so the Google redirect can return to the site. Mutation endpoints require the exact same Origin. OAuth codes, secrets and upstream error bodies are never put into application logs or page messages.

References: [Google OpenID Connect server flow](https://developers.google.com/identity/openid-connect/openid-connect), [jose JWT verification](https://github.com/panva/jose).

### Editing and restoring

Provider switches, individual availability, picker visibility, default, order, labels, descriptions, routes and reference prices are editable. Prices are entered in **US cents** and stored as USD, matching the existing API. New entries start disabled. Use **Validate changes** to review the production validator's results and a change summary, add a short change note, then publish. Editing the document again invalidates the validation preview; the server always validates again before publishing. Hiding a model permits explicit requests, while disabling it blocks them. Validation warns when no models will be visible or when the chosen default must fall back.

The history shows the timestamp, Google identity, change note and action for each accepted version. **View version** opens the immutable snapshot. **Restore this version** publishes a new version with the old settings in one click, records its source and preserves all subsequent history. Restore buttons are disabled while a draft is dirty, so rollback cannot silently discard edits. Stale tabs receive a conflict instead of overwriting newer work. An intentionally empty catalogue and all-provider pause remain valid configurations.

`ModelCatalogueAdmin` is a single control-plane Durable Object (`model-catalogue-v1`) that serializes admin writes, keeps immutable snapshots and handles interrupted publication through a durable outbox and alarm. The `v2-model-catalogue-admin` migration provisions its storage. The object writes to the existing `MODEL_REGISTRY` namespace; **apps and generation admission continue to read KV directly**. Admin history does not sit on the generation path. Keep both namespaces and all migrations on subsequent deployments; never recreate the admin namespace to update code.

Each publish/restore carries an idempotency key and expected base version. History is paginated in groups of 20. If a KV write or subsequent history commit fails, publishing stays pending and resumes after restart; the same request cannot create a second version or republish an old one. The UI checks an uncertain request's receipt before allowing another edit. Do not overwrite a pending publication using another tool.

Direct KV edits with a **fresh revision** are imported into history the next time admin controls observe them, with an external-change attribution rather than a fabricated Google identity. Previously known snapshots can still be returned by KV caches, so restoring by manually writing an old document without a new revision cannot be distinguished from propagation delay. Use the rollback control for restores. Avoid mixing dashboard/CLI writes with admin publishing concurrently: KV does not offer compare-and-swap across those independent tools. If a direct edit makes the live document invalid, the admin page keeps the last recorded version, warns about the live value and allows a validated publish/restore to repair it.

### Checks

Install the pinned authentication dependency before running comparison tests:

```sh
npm ci --ignore-scripts --no-fund --no-audit --prefix workers/generation-lab
node workers/generation-lab/tests/admin-auth.mjs
node workers/generation-lab/tests/model-admin.mjs
node workers/generation-lab/tests/worker.mjs
node --check workers/generation-lab/public/admin/models.js
```

Auth tests exercise cryptographically signed synthetic Google identities, the PKCE/state/nonce flow, the owner allowlist, expiration, rotation and CSRF. Store/API tests cover invalid drafts, immutable versions, attribution, concurrent stale tabs, rollback, pagination, direct-edit imports and ambiguous publication recovery. No test calls Google or changes production KV. After replacing OAuth credentials, repeat a real Google sign-in as a rollout check; the initial production sign-in passed on 31 October 2026.

Retention deployment: run `node Scripts/test_image_retention.mjs` and the library tests. Deploy both the API and comparison Workers before removing `deleteObjectsTransition` from the bucket-wide `recovery-images` R2 lifecycle rule. Preserve its multipart-upload abort policy and all other bucket rules. The hourly API sweep keeps the 24-hour expiry for ordinary app PNGs, exempts the configured comparison account, and leaves diagnostic JSON to the separate seven-day sweep. Never restore a blanket object-expiry rule on this shared bucket. Files deleted by the earlier rule cannot be recreated by changing retention.
