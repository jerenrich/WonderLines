# App Store submission records

**1.0 (10) is the next submission; it has not been archived, uploaded or submitted.** Source on `main` sets build 10. Draft review notes: [build 10 review notes](2026-11-01/build10-review-notes.txt).

1.0 (9) was uploaded on 31 October but never selected for the version or submitted; it is superseded by build 10. Its records ([preparation](2026-10-31/build9-preparation.json), [artifact verification](2026-10-31/build9-artifact-verification.json), [upload](2026-10-31/build9-upload-and-selection.json), [draft notes](2026-10-31/build9-review-notes.txt)) remain historical. Since build 9, the backend added the moderation veto rule (policy `all-ages-v11-veto`), automatic and operator account suspension, and plain-language service errors; build 10 adds the matching app wording, suspension handling and the encryption declaration.

The latest recorded submission remains **1.0 (8), submitted 17 October 2026 at 08:50 PDT / 16:50 Europe/London**. Apple rejected it on 31 October for a generation error under guideline 2.1(a). A matching service session hit the eight-second Clef moderation timeout before image generation; see the [investigation](2026-10-31/investigation.json) and [sanitized findings](2026-10-31/log-findings.json). Build 8's original [submission receipt](2026-10-17/build8-resubmission.json), [verification](2026-10-17/build8-verification.txt), and [submitted review notes](2026-10-17/build8-review-notes.txt) remain historical records.

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
