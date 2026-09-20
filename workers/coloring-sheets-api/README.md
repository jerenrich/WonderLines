# coloring-sheets-api

Cloudflare Worker used by the iPad app for authenticated image generation. The Worker keeps the OpenAI API key server-side and accepts requests at `POST /generate`.

## Files

- `src/index.mjs` — dependency-free Worker entry point and small browser client.
- `wrangler.jsonc` — deployment identity, runtime compatibility date, and required secret names.

## Test locally

From the repository root:

```sh
node Scripts/test_worker.mjs
```

This replaces the upstream request with a synthetic response and makes no network calls or paid generations.

## Configure and deploy

Authenticate Wrangler with the intended Cloudflare account, then run these commands from this directory:

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put APP_PASSWORD
npx wrangler deploy
```

If those secrets already exist on the deployed `coloring-sheets-api` Worker, do not rotate or replace them just to deploy source changes. The Wrangler config validates that both required secrets exist before deployment.

Deployment is intentionally manual. Review source changes and run the offline test before deploying because a Worker change affects both the app and browser clients.
