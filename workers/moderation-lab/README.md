# Moderation lab

Small, framework-free comparison app for Jev, Clef and Clef-flash. Deployed as a separate Cloudflare Worker (`coloring-sheets-moderation-lab`) with static assets; it does not change the production image API.

## Use

Paste the private access key from the ignored local file `.secrets/moderation-lab-access-key` into the app, enter a description, and choose **Compare classifiers**. Each comparison runs three billed text checks in parallel through the existing `coloring-sheets` AI Gateway. It generates no images and consumes no sheet allowance. Cards show decisions, policy rejection reasons, latency, seven scores and model-specific thresholds. JSON export includes the submitted prompt and results, including unavailable models.

The default **Remember access for 30 days** option exchanges the key for a signed, expiring `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The key itself is not stored in browser storage, cookies or URLs. Returning visits hide the key input. **Forget access** clears this browser’s cookie. Rotating `LAB_ACCESS_KEY` invalidates all remembered sessions. Cookie-authenticated writes require the same-origin Origin header. Uncheck Remember access to use the key only for the current tab. Results remain in page memory until another comparison or reload. Prompts may be recorded by the existing AI Gateway, whose logging behavior is reused from the production moderation module. Worker observability is disabled and the app does not log submitted descriptions itself. Do not share the access key publicly. Authenticated comparisons are limited to ten per minute using a Cloudflare rate-limit binding (a local per-location limit, not a global billing budget).

## Source and policy

- `public/`: HTML, CSS and browser JavaScript; no build step or framework.
- `src/index.mjs`: authenticated comparison API.
- `tests/worker.mjs`: offline API checks.
- `wrangler.jsonc`: standalone deployment and AI, static-asset and rate-limit bindings.

The Worker directly imports `../coloring-sheets-api/src/moderation.mjs`, sharing its current questions, response validation, timeout, thresholds and assessments. The GitHub Worker workflow tests and deploys both Workers from the same main commit, so shared policy changes update the API and lab together. Manual API deployments must also redeploy the lab. The two uploads are sequential, not atomic; a failed lab upload must be retried. The UI's policy badge identifies this deployment's bundled policy; it does not dynamically read the production API's deployed configuration. Inputs are limited to 4,000 characters. Each model has an eight-second inference timeout; errors are shown independently, without exposing provider responses.

## Development and deployment

From this directory, with Node.js and authenticated Wrangler:

```sh
npx wrangler dev
npx wrangler secret put LAB_ACCESS_KEY
npx wrangler deploy --keep-vars
```

For local development put `LAB_ACCESS_KEY=your-local-key` in ignored `.dev.vars`. Local Workers AI calls may require a remote AI binding and authenticated Wrangler; offline tests need no Cloudflare access:

```sh
node tests/worker.mjs
node ../../Scripts/test_moderation.mjs
```

To rotate the deployed access key, run `wrangler secret put LAB_ACCESS_KEY` and securely update the ignored local key file to match.
