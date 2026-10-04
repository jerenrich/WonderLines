# App Store submission records

The current submitted baseline is [1.0 (2), submitted 4 October 2026](submissions/2026-10-04-1.0-build-2/README.md). It was verified against App Store Connect after submission and includes exact copy, privacy/rating/pricing choices, source/build identifiers, uploaded assets and evidence.

The `2026-10-04/` preparation folder contains drafts and newer local captures; it is not a record of the exact submission. Consult the dated baseline before changing app/backend behavior or preparing another release.

```sh
python3 Scripts/audit_app_store.py --include-working-tree
```

Keep dated baselines unchanged. Create a new baseline for each submission and compare both metadata and app/backend behavior. Keep review-only phone numbers and credentials private; the local contact annex is Git-ignored.
