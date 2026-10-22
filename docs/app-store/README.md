# App Store submission records

The latest recorded submission is **1.0 (8), submitted 17 October 2026 at 16:50 Europe/London**. App Store Connect showed **Waiting for Review** at that time. This is a historical record, not a fresh check of Apple's current status. See the [build 8 submission receipt](2026-10-17/build8-resubmission.json), [verification](2026-10-17/build8-verification.txt), and [submitted review notes](2026-10-17/build8-review-notes.txt). Build 8 replaced build 7; the public listing and automatic release after approval were preserved.

## Submission history

| Build | Recorded submission | Evidence |
| --- | --- | --- |
| 1.0 (8) | 17 October, 16:50 Europe/London | [Submission](2026-10-17/build8-resubmission.json); [verification](2026-10-17/build8-verification.txt) |
| 1.0 (7) | 17 October; subsequently replaced by build 8 | [Submission](2026-10-17/build7-resubmission.json); [verification](2026-10-17/build7-verification.txt) |
| 1.0 (6) | 17 October, 10:41 Europe/London; subsequently replaced | [Submission](2026-10-17/build6-resubmission.json); [verification](2026-10-17/build6-verification.txt) |
| 1.0 (5) | 17 October, 07:56 Europe/London; subsequently replaced | [Diagnosis and first-use fix](2026-10-17/diagnosis.txt); [submission](2026-10-17/deployment-resubmission.json) |
| 1.0 (4) | 6 October, 21:52 Europe/London; subsequently replaced | [Build 4 record](2026-10-06/README.md) |

The dated audits describe the code, service and metadata inspected at that time. Their findings are not a current list of defects. In particular, the build 6 billing/report race was subsequently fixed; `Scripts/test_reporting_concurrency.mjs` is the maintained regression check. The original reproduction and result remain historical evidence. Later log-cleanup records are in [operations](../operations/log-retention-verification.json).

Submitted replies and review notes are kept as historical evidence. Local alternative attachment drafts are excluded from Git; use the dated final response or submitted notes when establishing what Apple received.

The original listing baseline is [1.0 (2), submitted 4 October 2026](submissions/2026-10-04-1.0-build-2/README.md). It was verified against App Store Connect after submission and includes exact copy, privacy/rating/pricing choices, source/build identifiers, uploaded assets and evidence.

The `2026-10-04/` preparation folder contains drafts and newer local captures; it is not a record of the exact submission. Consult the dated baseline before changing app/backend behavior or preparing another release.

```sh
python3 Scripts/audit_app_store.py --include-working-tree
```

Keep dated baselines unchanged. Create a new baseline for each submission and compare both metadata and app/backend behavior. Keep review-only phone numbers and credentials private; the local contact annex is Git-ignored.
