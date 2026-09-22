# coloring-sheets-api

Cloudflare Worker used by the iPhone and iPad app for anonymous, authenticated image generation. The Worker keeps the OpenAI API key server-side and exposes `/v1` endpoints.

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

Authenticate Wrangler with the intended Cloudflare account, then deploy from this directory:

```sh
npx wrangler deploy --keep-vars
```

For a first deployment, create the `coloring-sheets-generations` R2 bucket and add the `OPENAI_API_KEY` and `ACCOUNT_TOKEN_SECRET` secrets. On an existing deployment, preserve both secrets. In particular, replacing `ACCOUNT_TOKEN_SECRET` invalidates every saved anonymous account credential and prevents renewal. The app contains no shared Worker password.

`GLOBAL_DAILY_GENERATION_LIMIT` is a dashboard-managed Worker variable, rather than a value in `wrangler.jsonc`. Set it to a whole number from `0` through `100000`; `0` pauses all generation. Change it in Cloudflare Dashboard → Workers & Pages → `coloring-sheets-api` → Settings → Variables and Secrets. The Worker fails closed if this setting is missing or malformed, and every dashboard change creates a new Worker version without requiring an app release or source-code edit. Use `--keep-vars` for source deployments so this dashboard value remains intact.

Deployment is intentionally manual. Review source changes and run the offline test before deploying because a Worker change affects both the app and browser clients.

`FREE_DAILY_ALLOWANCE` is configured as `1000` images per anonymous account per UTC day. Both access reporting and reservation enforcement accept whole-number allowances up to `100000`. Account reservations are serialized across the global budget call so simultaneous requests cannot reuse the same free allowance. The global daily limit remains an independent ceiling across all accounts.

## Account renewal

`POST /v1/installations/renew` accepts `{}` with the saved bearer credential and returns a new 30-day access token for the same `accountId`. Only this endpoint accepts expired tokens: it still verifies the signature and checks the account’s current `credentialId`. It never creates a new account, resets allowance, spends credit, or invokes image generation. Credits and existing generation records remain attached to the account. Revoking its credential ID or rotating the signing secret blocks renewal as well as access.

The signed credential stored in the device Keychain provides long-term renewal access until revoked; the 30-day expiry limits direct API use, not the lifetime of the device identity. This supports already-expired credentials from existing app installations without discarding their accounts. The renewal endpoint was deployed on 23 September 2026 as version `742dc241-7c55-4c6c-afa7-b930011c790e`. Cloudflare reports 100% traffic on that version. Offline tests cover expiry, retained credits/jobs, forged credentials, and revocation. The live renewal route returns its expected HTTP 401 JSON response for an invalid credential. Cloudflare blocks the default `Python-urllib/3.9` User-Agent with error 1010; curl and Python with an explicit `ColoringSheets-DeploymentCheck/1.0` User-Agent reach the Worker. This was isolated by changing only the User-Agent header in both clients. Use an explicit deployment-check identity for Python verification requests. An authenticated live renewal flow has not been exercised; the offline tests cover it.
