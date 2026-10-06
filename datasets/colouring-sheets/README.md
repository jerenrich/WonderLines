# WonderLines colouring-sheet dataset

Dataset created and published by **Jordan Erenrich** for WonderLines. [Project site](https://jerenrich.github.io/WonderLines/) · [GitHub repository](https://github.com/jerenrich/WonderLines) · [Public dataset](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets). The dataset card shows the 4×4 preview near the top; the [card-update receipt](reviews/20261005-sunburst-r01-huggingface-v1-card-update.json) records the verified update.

This collection starts with **25 short, natural prompts** for colouring-sheet reference images or LoRA experiments, such as "Dinosaur delivering pizza on the moon", "Ferrari racing a dragon" and "Bagel in paradise". The canonical, machine-readable artifact is [prompts/descriptions.json](prompts/descriptions.json). [DESCRIPTIONS.md](DESCRIPTIONS.md) is its readable catalogue.

The prompts mix animals, people, plants, vehicles, food, everyday objects and imaginary places. They read like something a person would type into the app, leaving visual details open to interpretation. Age complexity and colouring style are added separately. Each record also has a stable ID, tags, a suggested composition and core features for later review; these metadata fields are not part of the user's description.

## Age coverage

The app's Settings slider uses every whole year from **3 through 18**. Its current complexity rules are snapshotted in [prompts/generation-guidance.json](prompts/generation-guidance.json):

| Target ages | Current guidance |
| --- | --- |
| 3–5 | Very simple outlines, a few large enclosed areas, few objects and minimal background detail. |
| 6–8 | Simple outlines, large enclosed areas, several objects and a light background. |
| 9–12 | Moderate detail, varied medium areas and a detailed background. |
| 13–18 | Intricate outlines, smaller areas, fine details and a layered scene. |

One image for each description at each slider age gives **25 × 16 = 400 planned samples per model**, before additional variants. The app does not currently send the numeric age to the image model: it converts age to band guidance. With the suggested composition held constant, there are **100 distinct subject prompts** across those 400 slots. Different ages within a band therefore provide repeated samples of the same instructions, rather than distinct difficulty targets. Keep both `age_target` and `age_band` in the records. Age describes intended colouring complexity; visual review determines whether the result meets it.

If a smaller first collection is useful, one representative age per band (3, 6, 9 and 13) yields 100 images per model. If future guidance varies within a band, give it a new guidance version and record that version per sample.

## Directory layout

```text
datasets/colouring-sheets/
  collection.json                  Collection identity and planned age sweep
  DESCRIPTIONS.md                   Readable view of the 25 descriptions
  prompts/
    descriptions.json              Canonical subjects and stable IDs
    generation-guidance.json       Versioned age, composition and style guidance
  scripts/
    generate-worker.mjs            Resumable generation through the app Worker
  schemas/
    sample.schema.json             JSON Schema for sample records
  images/
    raw/                           Original outputs, organised by generation run
    curated/                       Accepted images for training or references
  metadata/
    sample.template.json           Planned example, not a generated sample
    samples/                       One JSON record per image attempt
  manifests/                       Run configurations and JSONL generation plans
  reviews/                         Review summaries and reference selections
  previews/                        Contact sheets grouped by prompt or age
  exports/                         Built publication or training packages
  publication/                     Hugging Face export settings, card and instructions
```

The empty folders contain `.gitkeep` files so Git preserves the structure. Raw outputs and built exports are ignored by Git. Prompts, manifests, metadata, reviews and deliberately selected curated images can be tracked. Before adding a large image collection, choose a binary storage approach such as Git LFS or external object storage.

## Sunburst generation run

Run `20261005-sunburst-r01` uses **GPT-Image-2.5 Sunburst** through the deployed app Worker. Its [summary](manifests/20261005-sunburst-r01.summary.json) records the latest saved progress and inference estimates. The run manifest, prompt/guidance snapshots and 400-row plan are in `manifests/`; successful PNGs are under `images/raw/20261005-sunburst-r01/age-XX/`, with individual records in `metadata/samples/`.

The run sends the app's structured request fields and uses its first composition, `side`, with one image per prompt and age. The Worker adds the same complexity, composition and provider style instructions used by the iPhone app. It requests 1456 × 1024 PNGs at the Worker's `low` quality setting. Ages 3, 6, 9 and 13 are generated first, followed by the other slider ages. At the owner's request, four anonymous dataset installations each handle 100 planned samples; moderation and the global service budget still apply. Installation credentials stay in the Git-ignored `.build/colouring-dataset/` directory.

From the repository root, run the following to inspect/prepare the offline plan or resume the authorized live run:

```sh
node datasets/colouring-sheets/scripts/generate-worker.mjs
node datasets/colouring-sheets/scripts/generate-worker.mjs --live
```

The runner saves each submission before sending it, persists unique generation IDs and the moderation batch IDs, and only uses GET to recover a previously submitted image. Completed or terminal failed samples are skipped on resume. `submitted` and `uncertain` records preserve attempts that still need recovery; do not delete their records or repeat their generation POSTs. The private run lock prevents simultaneous runners. If a process is forcibly stopped, confirm it has exited before removing its stale `.build/colouring-dataset/<run_id>.lock` file.

The deployed Worker's moderation cache has a batch limit, so this run shares a batch ID for each identical original description within an account. Age-specific subjects and generation IDs remain separate; all age variants of that description receive the same all-ages moderation decision. The initial plan contains provisional per-image batch IDs; each sample record contains the batch ID actually submitted. A small number of initial `moderation_unavailable` responses occurred before image reservation and are preserved in `reviews/<run_id>-unreserved-attempts.jsonl`. The explicit `--retry-unreserved` option can reconsider only those confirmed HTTP 503 moderation failures after GET establishes that no image job exists; it retains the generation ID and archives the failed record.

Records include the composed subject and the expected full provider prompt reconstructed from hashed local Worker source. The API reports model routing and usage but does not echo the provider prompt, so `worker.effective_prompt_source` documents that provenance. Successful outputs remain pending visual review; generation alone does not mark them as training-ready.

The [deployed-source check](reviews/20261005-sunburst-r01-deployed-source-check.json) records a read-only verification of the production Worker's provider prefix, age rules, side-view guidance and Sunburst route during the run. Source hashes are retained for provenance; credentials and the downloaded source remain private.

The [contact-sheet index](previews/README.md) links to all 16 ages for each prompt and all 25 prompts for each age. Contact sheets are thumbnails, not source images. The helper scripts below require Pillow, which is available in Codex's bundled Python runtime:

```sh
python3 datasets/colouring-sheets/scripts/build-contact-sheets.py
python3 datasets/colouring-sheets/scripts/verify-run.py --require-complete
```

The integrity check verifies coverage, source prompts, model provenance, image hashes and PNG decoding/dimensions. It writes its report under `reviews/`, produces a consolidated `manifests/<run_id>.results.jsonl`, and updates the generated count in `collection.json`; it does not make aesthetic or age-suitability decisions.

## Preparing a generation run

1. Choose a model and a unique run ID, for example `20261005-flux-klein4b-r01`. Save its provider, full model ID, available revision, guidance version, requested dimensions, parameters and seed policy in `manifests/<run_id>.json`. Select the actual model later; `collection.json` has no assumed model.
2. Expand the catalogue over the 16 age targets. Use each subject's suggested composition consistently across ages for a controlled comparison. If testing additional views, record each view as a separate variant. Save the plan as `manifests/<run_id>.jsonl`, one planned sample per line.
3. Name each sample `<description_id>-age<two_digits>-<run_id>-v<two_digits>`, for example `cs001-age03-20261005-flux-klein4b-r01-v01`. Create `metadata/samples/<sample_id>.json` from the template. Keep IDs unique across models, runs and variants. The template's `example` ID is a placeholder and must be replaced.
4. Compose the subject using `subject_template`, the matching age band and the selected composition view. This matches the current Worker composition logic. When using the app's structured endpoint, send the base `description`, `age` and `composition` alongside its other required request fields; the Worker adds guidance itself. When generating directly, apply the chosen provider's style wrapper once. Save the exact effective prompt and negative prompt actually sent, rather than assuming all adapters use the standard prefix.
5. Store original bytes at `images/raw/<run_id>/age-<two_digits>/<sample_id>.<extension>`. Record timestamps, requested and reported parameters, actual output dimensions, media type and SHA-256. Store unavailable seeds or revisions as `null`; a requested seed is separate from a reported seed. Keep failed attempts with `status: failed` and a failure reason, with no fabricated image. Keep credentials and authenticated recovery links out of tracked manifests and metadata.

All subject/age/composition combinations in this catalogue fit the app's 500 UTF-16-unit subject limit. This excludes the provider's style prefix, which the server adds later. The default 1456 × 1024 landscape request matches the app; actual image sizes may differ by provider. The guidance file is a dated snapshot, so compare it with the app and Worker when preparing later runs.

## Review, captions and splits

Review generated images against the description's `core_features`, enclosed colouring areas, unwanted shading or text, target complexity and print quality. Record pass/fail results and reasons in each sample record. Accept an image only after all five checks pass; rejected or pending images stay out of the curated set. Copy accepted images to `images/curated/<sample_id>.<extension>` and retain the original record and hash. If editing an image, create a derived sample with its own hash and documented lineage rather than treating the edited bytes as the original.

Write `review.caption` from the actual accepted image. Describe its visible subject, black-outline colouring style and observed complexity. The generation prompt records intent and may include objects the model omitted; it is not automatically a verified training caption. Keep any future LoRA trigger token and training settings in the training export configuration.

Assign train/validation/test splits **by `description_id`**, keeping every age, composition variant and model output for a subject together. This prevents the same scene at another age from entering a held-out split. For reference-image use, choose a small reviewed selection for each age band and record the selection in `reviews/`. This is a starter collection; image review and later diversity expansion will determine its usefulness for training.

## Future publication and training exports

An initial Hugging Face archive is prepared under `exports/20261005-sunburst-r01-huggingface-v1/`. It contains all 400 original PNGs with a default `all` configuration and four age-band configurations, subject-grouped train/validation/test splits, and a balanced 300-image selection flag. [publication/README.md](publication/README.md) explains rebuilding, loading, validation and uploading. [publication/DATASET_CARD.md](publication/DATASET_CARD.md) is its Git-trackable dataset card. The archive was uploaded on 2026-10-06 to the repository [jerenrich/wonderlines-colouring-sheets](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets). All 416 package files were verified against remote sizes and hashes; the [upload receipt](reviews/20261005-sunburst-r01-huggingface-v1-upload.json) records the exact commit. The owner made the dataset public on 2026-10-06; the [publication receipt](reviews/20261005-sunburst-r01-huggingface-v1-publication.json) confirms access without authentication.

This archive deliberately includes pending images for review and preservation. Every `text` caption is marked `prompt-derived-unverified` and every `training_ready` flag is false. The export assigns splits in its own metadata and manifest without changing the source records. Structural validation does not constitute visual acceptance. A curated training export should include accepted images with captions written from their actual contents, using a fresh export ID. Preserve an export manifest listing sample IDs, split membership, source hashes, catalogue/guidance versions and any preprocessing. A training adapter can also emit image/caption pairs in the format required by the chosen trainer.

The dataset license is **CC BY 4.0** (`cc-by-4.0`), selected by the owner on 2026-10-06. [LICENSE](LICENSE) contains the complete terms, and [publication/ATTRIBUTION.md](publication/ATTRIBUTION.md) explains crediting **WonderLines**, linking the source and license, and indicating changes. This license applies to the dataset content to the extent the owner holds the relevant rights; it does not change application or tooling licenses. The generated Hugging Face package includes the license and attribution notice.

The dataset card documents synthetic origin, source models, generation settings, age interpretation, review criteria, splits and limitations. The license choice does not resolve separate provider contractual restrictions or third-party rights. Check the applicable OpenAI agreement's competing-model restriction before LoRA training, and check training/deployment compatibility once a base model and serving route are chosen.

The JSON Schema checks record structure and age/band consistency. A later generation/export tool should also check status-dependent completeness, file existence and hashes, subject length, review acceptance, split grouping and caption/image correspondence before including a sample.
