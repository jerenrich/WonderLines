# Production operational alerts

`wonderlines-monitoring` receives Tail events from `coloring-sheets-api` and
`wonderlines-compare`. It has no public route and no secrets. The producer Workers
are already on the account's Workers plan; Tail execution and Durable Object
usage use Cloudflare's normal metered billing.

Only known structured failure fields are classified. Raw traces, request data,
prompts, images, provider messages and identifiers are neither persisted nor
forwarded. One Durable Object stores three category streaks and the last batch
timestamp. Existing application logs retain their existing retention policy.

## Alert policy

- Customer-blocking **`moderation_unavailable` qualifies on its first occurrence**,
  including a single eight-second timeout shared by several generation requests.
  The shared hourly cooldown still applies, and email waits for log ingestion and
  the next native query run. An exhausted cooldown can defer a new incident.
- Image, storage and degraded moderation failures must recur over at least **120 seconds**.
  Each failure must arrive within two minutes of the previous failure in its
  category. Duplicate timestamps and out-of-order events do not extend a streak.
- A single non-blocking error never becomes an incident merely because two minutes elapsed.
  Successful requests do not hide recurring failures affecting other requests.
- All categories share one **3,600-second cooldown**, persisted across restarts.
  A batch emits one `operational_alert_batch` log per currently eligible category.
  The three existing Cloudflare email policies query these logs, so a batch can
  produce one to three emails. A new category during the cooldown waits for the
  next batch and must still be recurring when that batch is emitted.
- Reminders require fresh failure events. A quiet or recovered incident cannot
  generate a delayed reminder from old history.
- Normal content moderation rejections are excluded. Moderation unavailability
  and degraded parallel moderation are included. Current completion events use
  `availability=partial` or `unavailable`; the older `degraded=true` format is
  recognized too.

The email policies run each minute with a five-minute rolling window, threshold
`> 0`, and an hourly repeat interval. The rolling window supports delivery; the
Durable Object enforces the grace period and shared batch limit. Email delivery
also depends on log ingestion and Cloudflare scheduling, so it is not an exact
two-minute delivery SLA.

This is **traffic-based failure monitoring**, not an active availability probe.
No requests means no evidence of a provider outage. Cloudflare-wide outages may
affect both the API and monitoring. An external uptime check is still needed for
independent availability coverage. No inference calls are made by monitoring.

## Deploy and verify

Run `node Scripts/test_monitoring.mjs` from the repository root. CI deploys this
Worker before its producers. Both producer Wrangler configs retain the
`tail_consumers` attachment for future deployments.

To attach an already deployed producer without uploading application code, use
Cloudflare's documented `PATCH /accounts/{account}/workers/scripts/{name}/script-settings`
with `tail_consumers`, preserving any existing consumers. Verify the source's
active deployment did not change. See the dated deployment record in
`docs/operations/2026-10-31/monitoring-filter-deployment.json`.

Do timing/failure tests offline. The disposable TEST notification policy was
deleted. If an actual delivery test is necessary later, use a temporary policy
whose name begins `TEST`, then delete it; testing a production policy uses its
real subject and creates misleading email.

Cloudflare documentation:
[Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/),
[script settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/).
