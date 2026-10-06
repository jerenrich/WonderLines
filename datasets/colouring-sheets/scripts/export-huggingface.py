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
    lines = ["---", "language:", "- en", "task_categories:",
             "- text-to-image", "tags:", "- synthetic", "- colouring-pages",
             "- imagefolder", "size_categories:", "- n<1K"]
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
    lines.extend(["---", "", "# WonderLines synthetic colouring sheets", "",
                  "![4×4 preview of four colouring-sheet subjects across four difficulty bands](" + config["preview"]["export_path"] + ")", "",
                  "Four subjects across four difficulty bands. Columns show target ages 3, 6, 9 and 13. "
                  "This contact sheet is a browsing preview; original PNGs are stored under `data/`.", "",
                  "Dataset created and published by **" + config["creator_name"] + "** for **WonderLines**.", "",
                  "[WonderLines project site](" + config["project_url"] + ") · "
                  "[GitHub repository](" + config["source_repository_url"] + ")", "",
                  "400 original PNGs generated from 25 short subjects across slider ages 3–18. "
                  "Use the default `all` configuration or one of four age-band configurations. "
                  "These configurations select the same stored images; they do not duplicate them.", "",
                  "## Status", "",
                  "This is an archive of generated candidates, **not a curated training release**. "
                  "All images await visual review. `training_ready` is false and `verified_caption` "
                  "is null for every row. `text` is a draft derived from the requested subject, "
                  "style and difficulty instructions; it may describe details absent from the image. "
                  "Verify or replace it before using it as a training caption.", "",
                  "Publication license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), "
                  "to the extent the dataset owner holds copyright or similar rights. See `LICENSE` "
                  "for the complete terms and `ATTRIBUTION.md` for credit guidance. Attribution name: "
                  + config["attribution_name"] + ". When sharing, provide credit, link to the license "
                  "and indicate changes. Commercial reuse is allowed under the license. "
                  "This does not grant third-party trademark rights or resolve separate provider "
                  "contractual restrictions on model training.", "",
                  "## Coverage and age meaning", "",
                  "| Configuration | Images | Requested complexity |", "| --- | ---: | --- |"])
    complexities = {r["age_band"]: r["complexity_guidance"] for r in rows}
    for band in bands:
        lines.append(f'| `{band}` | {report["age_band_counts"][band]} | {complexities[band]} |')
    lines.extend(["", "The numeric `age_target` records the app slider setting. The model received "
                  "the band's complexity instructions, not the numeric age. Ages in one band "
                  "are repeated stochastic samples of identical instructions. These are intended "
                  "difficulty labels, not verified developmental or age-suitability assessments.", "",
                  "The oldest band has more images because it covers six slider ages. "
                  "`balanced_subset == true` selects 300 images: three per subject per band, "
                  "75 per band. Selection is deterministic and does not assess quality. "
                  "For a training experiment, use this selection or sample each band equally.", "",
                  "## Splits", "",
                  "Subjects are assigned deterministically using SHA-256 of a fixed seed and "
                  "description ID. All ages of a subject stay together, including in the balanced "
                  "selection. Train: 20 subjects / 320 images; validation: 3 subjects / 48 images; "
                  "test: 2 subjects / 32 images. Counts for individual configurations are recorded "
                  "in `export-manifest.json`. Held-out splits are small; results will be sensitive "
                  "to which subjects were selected. Future runs must reuse this subject assignment "
                  "to retain the same evaluation boundary.", "",
                  "## Generation provenance", "",
                  "Requested and reported model: `gpt-image-2.5-sunburst` (GPT-Image-2.5 Sunburst). "
                  "The iPhone app's Cloudflare Worker routed requests to OpenAI via Cloudflare AI "
                  "Gateway. Run: `" + config["run_id"] + "`. All outputs are 1456 × 1024 PNGs; "
                  "requested quality was `low`, with one image and side composition per request. "
                  "Model revision and seed were unavailable. Exact slider guidance, provider "
                  "prompts, generation timestamps and image hashes are retained per row. "
                  "`effective_prompt` was reconstructed from verified Worker source; the API did "
                  "not echo it. No resizing, cropping, thresholding or other image edits were made.", "",
                  "The subjects were deliberately varied across animals, people, food, vehicles "
                  "and imaginary scenes. The collection contains only 25 subject ideas and one "
                  "composition, which limits diversity. It is synthetic and was not collected "
                  "from children or real-user uploads. Generation accounts, credentials, Worker "
                  "request identifiers and recovery URLs are excluded from this package.", "",
                  "## Fields", "",
                  "- `image`: decoded source image (ImageFolder derives this from `file_name`).",
                  "- `text`, `caption_status`, `verified_caption`: provisional caption and its provenance.",
                  "- `sample_id`, `description_id`, `description`, `tags`: stable IDs and original subject.",
                  "- `age_target`, `age_band`, `complexity_level`, `complexity_guidance`: intended difficulty.",
                  "- `split`, `balanced_subset`: deterministic sampling and evaluation membership.",
                  "- `review_status`, `training_ready`: review state, not a quality score.",
                  "- `provider`, `model_id`, `model_revision`, `guidance_version`, `run_id`, `generated_at`: provenance.",
                  "- `subject_prompt`, `effective_prompt`, `effective_prompt_source`, `negative_prompt`: generation instructions.",
                  "- `composition`, `quality`, `seed`, `width`, `height`, `sha256`: output and requested settings.", "",
                  "## Loading", "", "```python", "from datasets import load_dataset", "",
                  'ds = load_dataset("' + config["repository_id"] + '", "all")',
                  'young = load_dataset("' + config["repository_id"] + '", "ages-03-05")',
                  'balanced_train = ds["train"].filter(lambda row: row["balanced_subset"])',
                  'age_six = ds["train"].filter(lambda row: row["age_target"] == 6)', "```", "",
                  "Locally, replace the repository ID with this package's absolute directory. "
                  "The `text` field can be passed to a compatible trainer after caption review. "
                  "A model may not learn four useful difficulty levels from this small collection; "
                  "compare outputs on held-out subjects and expand reviewed examples as needed.", "",
                  "## Review and release limitations", "",
                  "Before a curated release, inspect subject fidelity, enclosed colouring areas, "
                  "unwanted shading/text, observed complexity and print quality. Record accepted "
                  "captions from visible contents. Structural checks confirm image integrity and "
                  "coverage, not these visual properties. One prompt mentions Ferrari; it was "
                  "user supplied and does not imply affiliation. CC BY 4.0 has been selected; "
                  "source-model/output terms and third-party rights still require review. "
                  "In particular, check the applicable OpenAI agreement's restriction on using "
                  "outputs to develop competing models before LoRA training; the dataset license "
                  "does not override that agreement. The owner has published this collection "
                  "with image, caption and rights review still pending.", ""])
    return "\n".join(lines)


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
