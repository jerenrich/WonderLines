---
pretty_name: WonderLines Colouring Sheets
language:
- en
task_categories:
- text-to-image
tags:
- synthetic
- colouring-pages
- coloring-pages
- line-art
- image
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

# WonderLines: 400 synthetic colouring sheets

**The same subject, from simple outlines to intricate scenes.** A small collection for exploring how difficulty prompts change AI-generated colouring pages.

I'm **Jordan Erenrich**, the creator of [WonderLines](https://jerenrich.github.io/WonderLines/). I'm sharing these images and their generation metadata to invite feedback from people working on image generation, creative tools and colouring-page design.

![Four subjects shown across four requested difficulty bands, from simple to intricate](assets/band-overview.jpg)

Left to right: slider ages 3, 6, 9 and 13. The labels describe **requested complexity**, not validated age suitability. The preview shows 16 of the 400 images; original PNGs are available below.

[Browse the images](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets/viewer/all/train) · [Download files](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets/tree/main/data) · [Share feedback](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets/discussions) · [Project & code](https://github.com/jerenrich/WonderLines)

## What is included?

- **400 original PNGs**, 1456 × 1024 pixels, generated with OpenAI's GPT-Image-2.5 Sunburst (`gpt-image-2.5-sunburst`).
- **25 subjects** spanning animals, people, food, vehicles and imaginary scenes, each generated at slider ages 3–18.
- **Four requested difficulty bands**, with the original subjects, prompts, difficulty instructions and generation metadata.
- **CC BY 4.0** publication license, with attribution to WonderLines; see the license notes below.

**Review status:** these are unreviewed generated candidates. Captions are prompt-derived drafts and may not match the images. Every row has `training_ready = false` and `verified_caption = null`. Inspect images and captions before using them for training or activities with children.

## Feedback welcome

I'd love to hear your thoughts or see what you make with these images. [Share feedback or a project in the discussions](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets/discussions).

## Try it

You can browse the viewer or download PNGs using the links above. For Python, install `datasets` and `Pillow`, then load a sample without downloading the full collection:

```python
from datasets import load_dataset

ds = load_dataset("jerenrich/wonderlines-colouring-sheets", "all", streaming=True)
example = next(iter(ds["train"]))
print(example["sample_id"], example["description"], example["age_band"])
example["image"].save("wonderlines-example.png")
```

Use `"ages-03-05"`, `"ages-06-08"`, `"ages-09-12"` or `"ages-13-18"` instead of `"all"` for one band. Omit `streaming=True` to download a configuration for local use.

## Difficulty bands

| Configuration | Images | Requested complexity |
| --- | ---: | --- |
| `ages-03-05` | 75 | Very simple |
| `ages-06-08` | 75 | Simple |
| `ages-09-12` | 100 | Moderate |
| `ages-13-18` | 150 | Intricate |

The model received each band's complexity instructions, not a numeric age. Ages within a band repeat the same instructions with different generated outputs. These labels are not developmental assessments.

## License and credit

Published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), to the extent the dataset owner holds copyright or similar rights. When sharing, credit **WonderLines**, link to the dataset and license, and indicate changes. See [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md) for full terms and credit guidance.

The dataset license does not override provider contracts or grant third-party trademark rights. Source-provider terms and third-party rights review are still pending; see the limitations below before model-training reuse.

## Technical details

<details>
<summary>Splits, balancing and exact difficulty instructions</summary>

All images of a subject stay in one split: **20 train subjects / 320 images**, **3 validation subjects / 48 images**, and **2 test subjects / 32 images**. The assignment uses SHA-256 of a fixed seed and description ID. Future runs must reuse that assignment to preserve the evaluation boundary. Validation and test sets are small, so results will depend heavily on the held-out subjects. Per-configuration counts are in [export-manifest.json](export-manifest.json).

The oldest band contains more images because it spans six slider ages. `balanced_subset == true` selects **300 images**, three per subject per band and 75 per band. Selection is deterministic, not a quality ranking. Configurations select the same stored images without duplicating them; the preview is excluded.

```python
# With the non-streaming dataset loaded:
balanced_train = ds["train"].filter(lambda row: row["balanced_subset"])
age_six = ds["train"].filter(lambda row: row["age_target"] == 6)
```

Exact requested guidance:

- `ages-03-05`: very simple outlines, a few large enclosed coloring areas, few objects, minimal background detail.
- `ages-06-08`: simple clear outlines, large enclosed coloring areas, several objects, light background detail.
- `ages-09-12`: moderately detailed outlines, varied medium coloring areas, several objects and a detailed background.
- `ages-13-18`: intricate outlines, smaller enclosed coloring areas, many fine details and a rich, layered scene.

</details>

<details>
<summary>Generation provenance and metadata fields</summary>

Run: `20261005-sunburst-r01`. Requested and reported model: `gpt-image-2.5-sunburst` (GPT-Image-2.5 Sunburst). The WonderLines iPhone app's Cloudflare Worker routed requests to OpenAI via Cloudflare AI Gateway. Requested quality was `low`, with one image and side composition per request. Model revision and seed were unavailable. No resizing, cropping, thresholding or other image edits were made.

Exact slider guidance, provider prompts, generation timestamps and image hashes are retained per row. `effective_prompt` was reconstructed from verified Worker source; the API did not echo it. This is synthetic data, not images collected from children or real-user uploads. Generation accounts, credentials, Worker request identifiers and recovery URLs are excluded.

| Fields | Meaning |
| --- | --- |
| `image` | Source image, decoded from ImageFolder's `file_name` |
| `text`, `caption_status`, `verified_caption` | Draft caption and its review status |
| `sample_id`, `description_id`, `description`, `tags` | Stable IDs and original subject |
| `age_target`, `age_band`, `complexity_level`, `complexity_guidance` | Requested difficulty and app slider setting |
| `split`, `balanced_subset` | Evaluation and sampling membership |
| `review_status`, `training_ready` | Review state, not a quality score |
| `provider`, `model_id`, `model_revision`, `guidance_version`, `run_id`, `generated_at` | Generation provenance |
| `subject_prompt`, `effective_prompt`, `effective_prompt_source`, `negative_prompt` | Generation instructions |
| `composition`, `quality`, `seed`, `width`, `height`, `sha256` | Output and requested settings |

For local loading, replace the repository ID with the export directory's absolute path.

</details>

<details>
<summary>Review checklist and limitations</summary>

The collection contains only 25 subject ideas, one model and one composition setting. It is not a curated training release or an established benchmark for age suitability or model performance.

Before a curated release, inspect subject fidelity, enclosed colouring areas, unwanted shading or text, observed complexity and print quality. Verify or replace draft captions using visible image contents. Structural checks confirm file integrity and coverage, not visual quality. A model may not learn four useful difficulty levels from this small collection; any future training experiment needs reviewed examples and held-out evaluation.

One prompt mentions Ferrari; this does not imply affiliation. Applicable source-model/output terms and third-party rights still require review. In particular, check the applicable OpenAI agreement's restriction on using outputs to develop competing models before LoRA training; the dataset license does not override that agreement. Image, caption and rights review remain pending.

</details>
