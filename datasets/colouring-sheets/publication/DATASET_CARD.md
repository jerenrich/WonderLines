---
language:
- en
task_categories:
- text-to-image
tags:
- synthetic
- colouring-pages
- imagefolder
size_categories:
- n<1K
license: cc-by-4.0
configs:
- config_name: all
  drop_labels: true
  default: true
  data_files:
  - split: train
    path: "data/*/train/**"
  - split: validation
    path: "data/*/validation/**"
  - split: test
    path: "data/*/test/**"
- config_name: ages-03-05
  drop_labels: true
  data_files:
  - split: train
    path: "data/ages-03-05/train/**"
  - split: validation
    path: "data/ages-03-05/validation/**"
  - split: test
    path: "data/ages-03-05/test/**"
- config_name: ages-06-08
  drop_labels: true
  data_files:
  - split: train
    path: "data/ages-06-08/train/**"
  - split: validation
    path: "data/ages-06-08/validation/**"
  - split: test
    path: "data/ages-06-08/test/**"
- config_name: ages-09-12
  drop_labels: true
  data_files:
  - split: train
    path: "data/ages-09-12/train/**"
  - split: validation
    path: "data/ages-09-12/validation/**"
  - split: test
    path: "data/ages-09-12/test/**"
- config_name: ages-13-18
  drop_labels: true
  data_files:
  - split: train
    path: "data/ages-13-18/train/**"
  - split: validation
    path: "data/ages-13-18/validation/**"
  - split: test
    path: "data/ages-13-18/test/**"
---

# WonderLines synthetic colouring sheets

![4×4 preview of four colouring-sheet subjects across four difficulty bands](assets/band-overview.jpg)

Four subjects across four difficulty bands. Columns show target ages 3, 6, 9 and 13. This contact sheet is a browsing preview; original PNGs are stored under `data/`.

Dataset created and published by **Jordan Erenrich** for **WonderLines**.

[WonderLines project site](https://jerenrich.github.io/WonderLines/) · [GitHub repository](https://github.com/jerenrich/WonderLines)

400 original PNGs generated from 25 short subjects across slider ages 3–18. Use the default `all` configuration or one of four age-band configurations. These configurations select the same stored images; they do not duplicate them.

## Status

This is an archive of generated candidates, **not a curated training release**. All images await visual review. `training_ready` is false and `verified_caption` is null for every row. `text` is a draft derived from the requested subject, style and difficulty instructions; it may describe details absent from the image. Verify or replace it before using it as a training caption.

Publication license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), to the extent the dataset owner holds copyright or similar rights. See `LICENSE` for the complete terms and `ATTRIBUTION.md` for credit guidance. Attribution name: WonderLines. When sharing, provide credit, link to the license and indicate changes. Commercial reuse is allowed under the license. This does not grant third-party trademark rights or resolve separate provider contractual restrictions on model training.

## Coverage and age meaning

| Configuration | Images | Requested complexity |
| --- | ---: | --- |
| `ages-03-05` | 75 | very simple outlines, a few large enclosed coloring areas, few objects, minimal background detail. |
| `ages-06-08` | 75 | simple clear outlines, large enclosed coloring areas, several objects, light background detail. |
| `ages-09-12` | 100 | moderately detailed outlines, varied medium coloring areas, several objects and a detailed background. |
| `ages-13-18` | 150 | intricate outlines, smaller enclosed coloring areas, many fine details and a rich, layered scene. |

The numeric `age_target` records the app slider setting. The model received the band's complexity instructions, not the numeric age. Ages in one band are repeated stochastic samples of identical instructions. These are intended difficulty labels, not verified developmental or age-suitability assessments.

The oldest band has more images because it covers six slider ages. `balanced_subset == true` selects 300 images: three per subject per band, 75 per band. Selection is deterministic and does not assess quality. For a training experiment, use this selection or sample each band equally.

## Splits

Subjects are assigned deterministically using SHA-256 of a fixed seed and description ID. All ages of a subject stay together, including in the balanced selection. Train: 20 subjects / 320 images; validation: 3 subjects / 48 images; test: 2 subjects / 32 images. Counts for individual configurations are recorded in `export-manifest.json`. Held-out splits are small; results will be sensitive to which subjects were selected. Future runs must reuse this subject assignment to retain the same evaluation boundary.

## Generation provenance

Requested and reported model: `gpt-image-2.5-sunburst` (GPT-Image-2.5 Sunburst). The iPhone app's Cloudflare Worker routed requests to OpenAI via Cloudflare AI Gateway. Run: `20261005-sunburst-r01`. All outputs are 1456 × 1024 PNGs; requested quality was `low`, with one image and side composition per request. Model revision and seed were unavailable. Exact slider guidance, provider prompts, generation timestamps and image hashes are retained per row. `effective_prompt` was reconstructed from verified Worker source; the API did not echo it. No resizing, cropping, thresholding or other image edits were made.

The subjects were deliberately varied across animals, people, food, vehicles and imaginary scenes. The collection contains only 25 subject ideas and one composition, which limits diversity. It is synthetic and was not collected from children or real-user uploads. Generation accounts, credentials, Worker request identifiers and recovery URLs are excluded from this package.

## Fields

- `image`: decoded source image (ImageFolder derives this from `file_name`).
- `text`, `caption_status`, `verified_caption`: provisional caption and its provenance.
- `sample_id`, `description_id`, `description`, `tags`: stable IDs and original subject.
- `age_target`, `age_band`, `complexity_level`, `complexity_guidance`: intended difficulty.
- `split`, `balanced_subset`: deterministic sampling and evaluation membership.
- `review_status`, `training_ready`: review state, not a quality score.
- `provider`, `model_id`, `model_revision`, `guidance_version`, `run_id`, `generated_at`: provenance.
- `subject_prompt`, `effective_prompt`, `effective_prompt_source`, `negative_prompt`: generation instructions.
- `composition`, `quality`, `seed`, `width`, `height`, `sha256`: output and requested settings.

## Loading

```python
from datasets import load_dataset

ds = load_dataset("jerenrich/wonderlines-colouring-sheets", "all")
young = load_dataset("jerenrich/wonderlines-colouring-sheets", "ages-03-05")
balanced_train = ds["train"].filter(lambda row: row["balanced_subset"])
age_six = ds["train"].filter(lambda row: row["age_target"] == 6)
```

Locally, replace the repository ID with this package's absolute directory. The `text` field can be passed to a compatible trainer after caption review. A model may not learn four useful difficulty levels from this small collection; compare outputs on held-out subjects and expand reviewed examples as needed.

## Review and release limitations

Before a curated release, inspect subject fidelity, enclosed colouring areas, unwanted shading/text, observed complexity and print quality. Record accepted captions from visible contents. Structural checks confirm image integrity and coverage, not these visual properties. One prompt mentions Ferrari; it was user supplied and does not imply affiliation. CC BY 4.0 has been selected; source-model/output terms and third-party rights still require review. In particular, check the applicable OpenAI agreement's restriction on using outputs to develop competing models before LoRA training; the dataset license does not override that agreement. The owner has published this collection with image, caption and rights review still pending.
