#!/usr/bin/env python3
"""Exercise the actual Hugging Face loader, every configuration and source image."""

import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT.parents[1] / ".build" / "hf-dataset-cache"
os.environ.setdefault("HF_HOME", str(CACHE))
os.environ.setdefault("HF_DATASETS_CACHE", str(CACHE / "datasets"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")

import datasets
from datasets import Image, load_dataset
from huggingface_hub import DatasetCard


def main():
    config = json.loads((ROOT / "publication/huggingface-export.json").read_text())
    package = ROOT / "exports" / config["export_id"]
    manifest = json.loads((package / "export-manifest.json").read_text())
    card = DatasetCard.load(package / "README.md")
    assert len(card.data.configs) == 5
    assert card.data.license == config["license"] == "cc-by-4.0"
    assert manifest["attribution_name"] == config["attribution_name"]
    assert (package / "LICENSE").read_bytes() == (ROOT / "LICENSE").read_bytes()
    assert hashlib.sha256((package / "LICENSE").read_bytes()).hexdigest() == manifest["license_sha256"]
    assert (package / "ATTRIBUTION.md").read_bytes() == (ROOT / "publication/ATTRIBUTION.md").read_bytes()
    assert hashlib.sha256((package / manifest["preview"]["file_name"]).read_bytes()).hexdigest() == manifest["preview"]["sha256"]
    results, all_rows = {}, []
    for name in ["all"] + list(config["expected_age_band_counts"]):
        ds = load_dataset(str(package), name=name)
        sizes = {split: len(part) for split, part in ds.items()}
        expected = manifest["split_counts"] if name == "all" else manifest["configuration_split_counts"][name]
        assert sizes == expected, (name, sizes, expected)
        assert "image" in ds["train"].features and "label" not in ds["train"].features
        for split, part in ds.items():
            assert part[0]["image"].size == (1456, 1024)
            raw = part.cast_column("image", Image(decode=False))
            for row in raw:
                assert row["split"] == split
                assert row["caption_status"] == "prompt-derived-unverified"
                assert row["verified_caption"] is None and row["training_ready"] is False
                if name != "all":
                    assert row["age_band"] == name
                else:
                    path = Path(row["image"]["path"])
                    assert package in path.parents
                    assert hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"]
                    all_rows.append(row)
        results[name] = sizes
    assert len(all_rows) == 400 and len({r["sample_id"] for r in all_rows}) == 400
    subject_splits = {}
    for row in all_rows:
        subject_splits.setdefault(row["description_id"], set()).add(row["split"])
    assert all(len(splits) == 1 for splits in subject_splits.values())
    balanced = [r for r in all_rows if r["balanced_subset"]]
    assert len(balanced) == 300
    assert all(sum(r["age_band"] == band for r in balanced) == 75 for band in config["expected_age_band_counts"])
    # Decode all originals through the same loader used by downstream consumers.
    ds = load_dataset(str(package), name="all")
    for part in ds.values():
        for row in part:
            row["image"].load()
            assert row["image"].size == (1456, 1024)
    report = {"passed": True, "datasets_version": datasets.__version__, "configurations": results,
              "images_loaded_and_hashed": len(all_rows), "balanced_samples": len(balanced),
              "subject_leakage": False, "caption_status": "prompt-derived-unverified",
              "training_ready_count": 0, "uploaded": False}
    (ROOT / "reviews" / (config["export_id"] + "-loader-check.json")).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
