#!/usr/bin/env python3
"""Build a portable ImageFolder package without credentials or Worker identifiers."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import shutil
import struct


ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def image_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def card(config, report, rows):
    bands = list(config["expected_age_band_counts"])
    lines = ["---", "pretty_name: WonderLines Colouring Sheets", "language:", "- en", "task_categories:",
             "- text-to-image", "tags:", "- synthetic", "- colouring-pages",
             "- coloring-pages", "- line-art", "- image", "- imagefolder", "size_categories:", "- n<1K"]
    if config["license"]:
        lines.append("license: " + config["license"])
    lines.append("configs:")
    for name in ["all"] + bands:
        lines.extend(["- config_name: " + name, "  drop_labels: true"])
        if name == "all":
            lines.append("  default: true")
        lines.append("  data_files:")
        for split in ("train", "validation", "test"):
            glob = "*" if name == "all" else name
            lines.extend(["  - split: " + split, '    path: "data/' + glob + '/' + split + '/**"'])
    lines.extend(["---", "", ""])
    complexity_names = ["Very simple", "Simple", "Moderate", "Intricate"]
    coverage = "\n".join(
        f'| `{band}` | {report["age_band_counts"][band]} | {label} |'
        for band, label in zip(bands, complexity_names)
    )
    guidance = "\n".join(
        f'- `{band}`: {next(r["complexity_guidance"] for r in rows if r["age_band"] == band)}'
        for band in bands
    )
    body = f"""# WonderLines: 400 synthetic colouring sheets

**The same subject, from simple outlines to intricate scenes.** A small collection for exploring how difficulty prompts change AI-generated colouring pages.

I'm **{config["creator_name"]}**, the creator of [WonderLines]({config["project_url"]}). I'm sharing these images and their generation metadata to invite feedback from people working on image generation, creative tools and colouring-page design.

![Four subjects shown across four requested difficulty bands, from simple to intricate]({config["preview"]["export_path"]})

Left to right: slider ages 3, 6, 9 and 13. The labels describe **requested complexity**, not validated age suitability. The preview shows 16 of the {report["sample_count"]} images; original PNGs are available below.

[Browse the images](https://huggingface.co/datasets/{config["repository_id"]}/viewer/all/train) · [Download files](https://huggingface.co/datasets/{config["repository_id"]}/tree/main/data) · [Share feedback](https://huggingface.co/datasets/{config["repository_id"]}/discussions) · [Project & code]({config["source_repository_url"]})

## What is included?

- **{report["sample_count"]} original PNGs**, 1456 × 1024 pixels, generated with OpenAI's GPT-Image-2.5 Sunburst (`gpt-image-2.5-sunburst`).
- **{len(report["subject_split_assignment"])} subjects** spanning animals, people, food, vehicles and imaginary scenes, each generated at slider ages 3–18.
- **Four requested difficulty bands**, with the original subjects, prompts, difficulty instructions and generation metadata.
- **CC BY 4.0** publication license, with attribution to WonderLines; see the license notes below.

**Review status:** these are unreviewed generated candidates. Captions are prompt-derived drafts and may not match the images. Every row has `training_ready = false` and `verified_caption = null`. Inspect images and captions before using them for training or activities with children.

## Feedback welcome

I'd love to hear your thoughts or see what you make with these images. [Share feedback or a project in the discussions](https://huggingface.co/datasets/{config["repository_id"]}/discussions).

## Try it

You can browse the viewer or download PNGs using the links above. For Python, install `datasets` and `Pillow`, then load a sample without downloading the full collection:

```python
from datasets import load_dataset

ds = load_dataset("{config["repository_id"]}", "all", streaming=True)
example = next(iter(ds["train"]))
print(example["sample_id"], example["description"], example["age_band"])
example["image"].save("wonderlines-example.png")
```

Use `"ages-03-05"`, `"ages-06-08"`, `"ages-09-12"` or `"ages-13-18"` instead of `"all"` for one band. Omit `streaming=True` to download a configuration for local use.

## Difficulty bands

| Configuration | Images | Requested complexity |
| --- | ---: | --- |
{coverage}

The model received each band's complexity instructions, not a numeric age. Ages within a band repeat the same instructions with different generated outputs. These labels are not developmental assessments.

## License and credit

Published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), to the extent the dataset owner holds copyright or similar rights. When sharing, credit **{config["attribution_name"]}**, link to the dataset and license, and indicate changes. See [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md) for full terms and credit guidance.

The dataset license does not override provider contracts or grant third-party trademark rights. Source-provider terms and third-party rights review are still pending; see the limitations below before model-training reuse.

## Technical details

<details>
<summary>Splits, balancing and exact difficulty instructions</summary>

All images of a subject stay in one split: **20 train subjects / 320 images**, **3 validation subjects / 48 images**, and **2 test subjects / 32 images**. The assignment uses SHA-256 of a fixed seed and description ID. Future runs must reuse that assignment to preserve the evaluation boundary. Validation and test sets are small, so results will depend heavily on the held-out subjects. Per-configuration counts are in [export-manifest.json](export-manifest.json).

The oldest band contains more images because it spans six slider ages. `balanced_subset == true` selects **{report["balanced_count"]} images**, three per subject per band and 75 per band. Selection is deterministic, not a quality ranking. Configurations select the same stored images without duplicating them; the preview is excluded.

```python
# With the non-streaming dataset loaded:
balanced_train = ds["train"].filter(lambda row: row["balanced_subset"])
age_six = ds["train"].filter(lambda row: row["age_target"] == 6)
```

Exact requested guidance:

{guidance}

</details>

<details>
<summary>Generation provenance and metadata fields</summary>

Run: `{config["run_id"]}`. Requested and reported model: `gpt-image-2.5-sunburst` (GPT-Image-2.5 Sunburst). The WonderLines iPhone app's Cloudflare Worker routed requests to OpenAI via Cloudflare AI Gateway. Requested quality was `low`, with one image and side composition per request. Model revision and seed were unavailable. No resizing, cropping, thresholding or other image edits were made.

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
"""
    return "\n".join(lines) + body



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "publication/huggingface-export.json")
    args = parser.parse_args()
    config = read_json(args.config)
    collection = read_json(ROOT / "collection.json")
    if config["license"] != "cc-by-4.0" or config["license"] != collection["dataset_license"]:
        raise ValueError("Export license must match the selected collection license")
    if not (ROOT / "LICENSE").is_file():
        raise ValueError("Dataset license text is missing")
    records = sorted((read_json(p) for p in (ROOT / "metadata/samples").glob("*.json")),
                     key=lambda r: r["sample_id"])
    records = [r for r in records if r["run_id"] == config["run_id"] and r["status"] == "generated"]
    if len(records) != config["expected_samples"]:
        raise ValueError("Run coverage differs from export configuration")
    ids = sorted({r["description_id"] for r in records},
                 key=lambda x: digest(config["split_seed"] + ":" + x))
    if len(ids) != config["expected_subjects"]:
        raise ValueError("Unexpected subject count")
    assignment = {subject: "train" for subject in ids}
    ntest = config["test_subjects"]
    for subject in ids[:ntest]:
        assignment[subject] = "test"
    for subject in ids[ntest:ntest + config["validation_subjects"]]:
        assignment[subject] = "validation"
    expected_pairs = {(s, a) for s in ids for a in config["expected_age_targets"]}
    if Counter((r["description_id"], r["age_target"]) for r in records) != Counter(expected_pairs):
        raise ValueError("Missing or duplicate subject/age pairs")
    if dict(Counter(r["age_band"] for r in records)) != config["expected_age_band_counts"]:
        raise ValueError("Unexpected age-band counts")
    groups = defaultdict(list)
    for r in records:
        groups[(r["description_id"], r["age_band"])].append(r["sample_id"])
    balanced = set()
    for values in groups.values():
        values.sort(key=lambda x: digest("wonderlines-balanced-v1:" + x))
        balanced.update(values[:config["balanced_samples_per_subject_band"]])
    catalogue = {d["id"]: d for d in read_json(ROOT / "prompts/descriptions.json")["descriptions"]}
    levels = dict(zip(config["expected_age_band_counts"], ["very_simple", "simple", "moderate", "intricate"]))
    output = ROOT / "exports" / config["export_id"]
    rows, files = [], defaultdict(list)
    hashes, byte_count = set(), 0
    for r in records:
        if not config["include_pending_review"] and r["review"]["status"] != "accepted":
            raise ValueError("Curated export contains an unaccepted image")
        path = (ROOT / r["image"]["raw_path"]).resolve()
        if ROOT not in path.parents:
            raise ValueError("Source image is outside the collection")
        sha = image_hash(path)
        if sha != r["image"]["sha256"] or sha in hashes:
            raise ValueError("Image hash mismatch or duplicate image")
        hashes.add(sha)
        with path.open("rb") as stream:
            header = stream.read(24)
        if header[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", header[16:24]) != (1456, 1024):
            raise ValueError("Unexpected image format/dimensions")
        split = assignment[r["description_id"]]
        relative = Path("data") / r["age_band"] / split / path.name
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or image_hash(target) != sha:
            shutil.copyfile(path, target)
        if image_hash(target) != sha:
            raise ValueError("Copied image differs from original")
        caption = r["review"]["caption"]
        reviewed = r["review"]["status"] == "accepted" and bool(caption)
        row = {
            "file_name": path.name, "sample_id": r["sample_id"],
            "description_id": r["description_id"], "description": r["description"],
            "tags": catalogue[r["description_id"]]["tags"],
            "text": caption if reviewed else "Black-outline colouring page on a white background. " + r["description"] + ". " + r["complexity_guidance"],
            "caption_status": "verified" if reviewed else "prompt-derived-unverified",
            "verified_caption": caption if reviewed else None,
            "age_target": r["age_target"], "age_band": r["age_band"],
            "complexity_level": levels[r["age_band"]], "complexity_guidance": r["complexity_guidance"],
            "split": split, "balanced_subset": r["sample_id"] in balanced,
            "review_status": r["review"]["status"], "training_ready": reviewed,
            "provider": r["provider"], "model_id": r["model_id"], "model_revision": r["model_revision"],
            "guidance_version": r["guidance_version"], "run_id": r["run_id"], "generated_at": r["generated_at"],
            "subject_prompt": r["subject_prompt"], "effective_prompt": r["effective_prompt"],
            "effective_prompt_source": r["worker"]["effective_prompt_source"], "negative_prompt": r["negative_prompt"],
            "composition": r["composition"], "quality": r["requested_parameters"]["quality"],
            "seed": r["requested_parameters"]["seed"], "width": r["image"]["width"],
            "height": r["image"]["height"], "sha256": sha,
        }
        rows.append(row)
        files[target.parent].append(row)
        byte_count += target.stat().st_size
    # A fixed export ID is immutable in membership: detect stale images rather than silently mixing releases.
    expected = {output / "data" / r["age_band"] / r["split"] / r["file_name"] for r in rows}
    if set(output.glob("data/**/*.png")) != expected:
        raise ValueError("Export contains unexpected images; use a fresh export ID")
    preview_source = (ROOT / config["preview"]["source_path"]).resolve()
    preview_target = output / config["preview"]["export_path"]
    if ROOT not in preview_source.parents or output.resolve() not in preview_target.resolve().parents:
        raise ValueError("Preview path is outside the collection or export")
    preview_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(preview_source, preview_target)
    for directory, entries in files.items():
        (directory / "metadata.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in entries), encoding="utf-8")
    report = {
        "export_id": config["export_id"], "run_id": config["run_id"], "format": "huggingface-imagefolder",
        "sample_count": len(rows), "image_bytes": byte_count, "unique_hashes": len(hashes),
        "age_band_counts": dict(sorted(Counter(r["age_band"] for r in rows).items())),
        "split_counts": dict(sorted(Counter(r["split"] for r in rows).items())),
        "configuration_split_counts": {b: dict(sorted(Counter(r["split"] for r in rows if r["age_band"] == b).items())) for b in levels},
        "balanced_count": len(balanced),
        "balanced_age_band_counts": dict(sorted(Counter(r["age_band"] for r in rows if r["balanced_subset"]).items())),
        "balanced_split_counts": dict(sorted(Counter(r["split"] for r in rows if r["balanced_subset"]).items())),
        "subject_split_assignment": dict(sorted(assignment.items())), "split_seed": config["split_seed"],
        "training_ready_count": sum(r["training_ready"] for r in rows), "license": config["license"],
        "attribution_name": config["attribution_name"],
        "creator_name": config["creator_name"],
        "project_url": config["project_url"],
        "source_repository_url": config["source_repository_url"],
        "preview": {"file_name": config["preview"]["export_path"], "sha256": image_hash(preview_target),
                    "purpose": "dataset-card contact sheet; excluded from dataset configurations"},
        "license_sha256": image_hash(ROOT / "LICENSE"),
        "image_processing": "none; byte-identical copies", "source_record_updates": "none",
        "rows": [{"sample_id": r["sample_id"], "file_name": "data/" + r["age_band"] + "/" + r["split"] + "/" + r["file_name"],
                  "sha256": r["sha256"], "split": r["split"], "balanced_subset": r["balanced_subset"]} for r in rows],
    }
    write_json(output / "export-manifest.json", report)
    write_json(ROOT / "reviews" / (config["export_id"] + "-export.json"), report)
    (output / "README.md").write_text(card(config, report, rows), encoding="utf-8")
    shutil.copyfile(ROOT / "LICENSE", output / "LICENSE")
    shutil.copyfile(ROOT / "publication" / "ATTRIBUTION.md", output / "ATTRIBUTION.md")
    shutil.copyfile(output / "README.md", ROOT / "publication" / "DATASET_CARD.md")
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=2))
    print("Package: " + str(output))


if __name__ == "__main__":
    main()
