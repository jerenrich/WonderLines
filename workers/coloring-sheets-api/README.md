# coloring-sheets-api

Cloudflare Worker used by the iPad app for anonymous, authenticated image generation. The Worker keeps the OpenAI API key server-side and exposes `/v1` endpoints.

## Files

- `src/index.mjs` — dependency-free Worker entry point and Durable Object account ledger.
- `wrangler.jsonc` — deployment identity, runtime compatibility date, Durable Object, and R2 bindings.

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
npx wrangler secret put ACCOUNT_TOKEN_SECRET
npx wrangler deploy
```

Create the `coloring-sheets-generations` R2 bucket in the intended account before deployment. Generate `ACCOUNT_TOKEN_SECRET` with a password manager and retain it securely: rotating it invalidates every anonymous session. The app no longer contains a shared Worker password.

Deployment is intentionally manual. Review source changes and run the offline test before deploying because a Worker change affects both the app and browser clients.
