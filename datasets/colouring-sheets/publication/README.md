# Hugging Face packaging

Use one dataset repository with default configuration `all` and four configurations `ages-03-05`, `ages-06-08`, `ages-09-12` and `ages-13-18`. Each PNG is stored once. The same age metadata lets you filter exact slider ages without maintaining 16 repositories. The app's prompt changes at band boundaries; ages within a band repeat the same instructions.

The generated package is `../exports/20261005-sunburst-r01-huggingface-v1/`: 400 PNGs, 12 metadata JSONL files, a dataset card, license, attribution notice, release manifest and the 4×4 preview at `assets/band-overview.jpg`. The preview is excluded from all dataset configurations. Images are byte-identical copies of the originals, approximately 645 MB. Metadata includes age, difficulty, original subject, draft caption, complete generation prompt, model provenance and review status. Credentials, account identifiers and Worker request identifiers are excluded.

The live dataset card credits **Jordan Erenrich**, links to the [WonderLines project site](https://jerenrich.github.io/WonderLines/) and [GitHub repository](https://github.com/jerenrich/WonderLines), and shows the preview near the top. The [card-update receipt](../reviews/20261005-sunburst-r01-huggingface-v1-card-update.json) records its commit and verification of all 417 package files.

## Build and validate

From the repository root:

```sh
python3 datasets/colouring-sheets/scripts/export-huggingface.py
```

The exporter uses the standard library. Its versioned settings are in [huggingface-export.json](huggingface-export.json). It verifies source and copied hashes, unique images, PNG dimensions, every subject/age pair and band counts. Rebuilding reuses matching image copies. It preserves original metadata and writes a Git-trackable export manifest under `reviews/`. Use a new export ID when changing release membership or processing images.

The optional loader check uses `datasets`, `huggingface_hub` and Pillow. Tested versions are pinned in [requirements-huggingface.txt](requirements-huggingface.txt); install them into your own virtual environment with `pip install -r datasets/colouring-sheets/publication/requirements-huggingface.txt`. A local virtual environment has already been prepared for this workspace:

```sh
.build/hf-dataset-tools/bin/python datasets/colouring-sheets/scripts/verify-huggingface.py
```

This exercises automatic local ImageFolder detection, all five configurations, metadata joins, split counts, caption flags, all 400 decoded images and hashes, the balanced selection and subject separation. Caches remain under the Git-ignored `.build/` folder. It does not require Hugging Face credentials or network access.

## Splits and balancing

All ages of each subject share one split: 20 train subjects (320 images), three validation subjects (48 images) and two test subjects (32 images). The assignment is saved in the export manifest. Reuse it for future runs; adding new subjects and recomputing the sorted hash allocation could otherwise change the held-out subjects.

The four bands contain 75, 75, 100 and 150 images. The boolean `balanced_subset` selects three images per subject per band, giving 300 images (75 per band). Its training split has 240 images, validation 36 and test 24. This provides an evenly represented starting selection for experiments; it is not a visual quality ranking. Alternatively use all images and sample bands equally. Keep the original collection available to improve captions and compare later selections.

For LoRA, start by testing one adapter with captions that express observed difficulty, then compare its results across the four bands on held-out subjects. Separate adapters may be useful if one adapter cannot follow the requested complexity consistently; separate dataset repositories are not necessary for that experiment. For reference use, select visually reviewed examples from each band.

## Loading locally

```python
from datasets import load_dataset

package = "/Users/jordan/Documents/ChatGPT/ColoringSheetsIpad/datasets/colouring-sheets/exports/20261005-sunburst-r01-huggingface-v1"
dataset = load_dataset(package, "all")
youngest = load_dataset(package, "ages-03-05")
balanced_train = dataset["train"].filter(lambda row: row["balanced_subset"])
```

## Upload when ready

The package was uploaded on 2026-10-06 to the public repository [jerenrich/wonderlines-colouring-sheets](https://huggingface.co/datasets/jerenrich/wonderlines-colouring-sheets). All 400 images and 16 supporting files passed remote size and hash verification. The [upload receipt](../reviews/20261005-sunburst-r01-huggingface-v1-upload.json) records the commit and verification result. The owner requested public access on 2026-10-06. The [publication receipt](../reviews/20261005-sunburst-r01-huggingface-v1-publication.json) confirms it can be accessed without authentication:

```python
from datasets import load_dataset

dataset = load_dataset("jerenrich/wonderlines-colouring-sheets", "all")
youngest = load_dataset("jerenrich/wonderlines-colouring-sheets", "ages-03-05")
```

The archive contains unreviewed candidates, not a curated training set. `text` is a draft derived from prompts and may not match the visible image. All `training_ready` fields are false. Visual review and verified captions are the next preparation step. The dataset card declares `license: cc-by-4.0`; the package includes `LICENSE` and [ATTRIBUTION.md](ATTRIBUTION.md), with **WonderLines** as the attribution name. The license choice does not override provider contracts; check the applicable OpenAI agreement's restriction on competing-model development before LoRA training. The owner published the dataset with image and rights review still pending; publication does not mark any image as training-ready.

Authenticate with an account authorised to write this repository (`hf auth login`) in an environment with `huggingface_hub` installed.

The prepared uploader uses the repository and visibility saved in `collection.json`. New destinations default to private; this dataset remains public as requested by the owner. It uploads only the allowlisted export files, verifies every remote file's size and hash, and writes a receipt under `reviews/`:

```sh
.build/hf-dataset-tools/bin/hf auth login
.build/hf-dataset-tools/bin/python datasets/colouring-sheets/scripts/upload-huggingface.py
```

Use `--namespace YOUR_ORGANISATION` for an organisation or `--check` for an offline package check. The uploader never prints or stores the login token in the dataset or receipt. The uploader preserves the visibility recorded in the collection settings; it does not change repository visibility during updates.


Upload **the export folder only**, rather than the application repository. Its README becomes the dataset card. [DATASET_CARD.md](DATASET_CARD.md) is the Git-trackable copy of that card. Built exports and source image binaries remain ignored in the application repository; scripts, settings, cards and reports can be committed normally.

Hugging Face's [ImageFolder guide](https://huggingface.co/docs/datasets/en/image_dataset) documents relative image filenames and JSONL metadata. Its [configuration guide](https://huggingface.co/docs/hub/datasets-manual-configuration) documents multiple views of one dataset, and its [upload guide](https://huggingface.co/docs/huggingface_hub/en/guides/upload) covers authenticated folder uploads.
