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

## Automated checks and deployment

The [Worker workflow](../.github/workflows/worker.yml) runs offline checks on
Worker pull requests and relevant pushes to `main`. Pull requests never deploy.
After the checks pass on `main`, only Workers whose deployment inputs changed
are deployed. iOS builds and App Store submissions are separate releases.

| Change | Automatic deployment |
| --- | --- |
| iOS app only | None |
| Worker README or other Markdown documentation only | None; workflow is skipped |
| Worker tests, test fixtures, or CI workflow only | None; checks run |
| Worker source, static assets, Wrangler config, or package/lockfile | Affected Worker(s) |
| Shared or imported code, including the initial model registry | Every Worker that bundles the changed file |

[Deployment selection](../Scripts/worker_deployments.mjs) follows relative
JavaScript imports transitively, so changing an API module used by a lab also
updates that lab. It includes added, renamed and deleted source/assets. Runtime
entry points belong under each Worker's `src/`, static assets under `public/`,
and dependencies in its package/lockfile; update the selector if introducing
another build-input location or nonliteral dynamic imports.

Production runs are serialized, check out current `main` after acquiring the
lock, and test that source before deployment. Selection compares against the
event commit of the most recent successful **push** run, rather than just the
latest commit. Failed runs and replaced queued runs therefore leave their
changes pending for the next production run. Files touched and then reverted
are included too, to restore any Worker updated before a partial failure.
A previous run may have tested a newer `main` than its event commit; this conservative baseline can repeat an
already completed deployment. Missing history, an unavailable history API, or
a rewritten branch causes all Workers to be selected.

When multiple Workers are selected, monitoring deploys before its producers and
the API before the labs. Deployment results, including skips and failures,
appear in the workflow summary. Log retention remains disabled until the
repository variable `LOG_RETENTION_WORKER_READY` is `true` after its dedicated
secret and bootstrap are ready.

For an explicit redeployment, open **Actions → Worker CI and deployment → Run
workflow**, select branch **main**, and choose `all` (the default) or an
individual Worker. Individual selection forces only that Worker; use `all` for
coordinated changes across Workers. Manual runs do not advance the automatic
deployment baseline because they can select only one Worker.

Deployment uses the existing repository Actions secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Checks and runs with no
selected deployments do not require Cloudflare credentials.

## Prompt comparison app

[`moderation-lab/`](moderation-lab/README.md) is a lightweight, standalone web app for comparing prompts across Jev, Clef and Clef-flash using the API's shared all-ages policy. It is deployed at [Coloring Sheets Prompt Lab](https://coloring-sheets-moderation-lab.jordan-erenrich.workers.dev). Live comparisons require the private lab access key stored locally in the ignored `.secrets/moderation-lab-access-key` file.
