# Cloudflare Workers

Each Cloudflare Worker lives in its own directory:

```text
workers/
  <worker-name>/
    README.md
    wrangler.jsonc
    src/
```

Keep Worker-specific source, configuration, tests, and documentation together. Shared code can be introduced under `workers/shared/` when a second Worker actually needs it; avoid creating abstractions before there is a concrete shared use case.

Secrets must never be committed. Declare required secret names in each Worker's Wrangler config, store deployed values with Wrangler or in the Cloudflare dashboard, and use an ignored `.dev.vars` file only for local development.
