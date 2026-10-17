# Security decisions

## 17 October 2026 — accepted moderation cost risk

Jordan explicitly accepted the risk that description moderation runs before the
image-generation budget check. Moderation is very cheap and considered unlikely
to be abused. Repeated or rejected requests can therefore incur moderation costs
even after the image-generation budget is exhausted. No moderation budget or
additional moderation throttling is being added for this finding.

The separate fixes for anonymous registration abuse and oversized request bodies
are documented in the image service README and covered by
`Scripts/test_request_security.mjs`.
