#!/usr/bin/env python3
"""Upload only the prepared dataset package, then verify every remote file."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

from huggingface_hub import HfApi, get_token
from huggingface_hub.errors import HfHubHTTPError, RepositoryNotFoundError

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--namespace", help="Hugging Face username or organisation; defaults to the logged-in username")
    parser.add_argument("--check", action="store_true", help="Check the package and token availability without network calls or uploading")
    args = parser.parse_args()
    config = json.loads((ROOT / "publication/huggingface-export.json").read_text())
    collection = json.loads((ROOT / "collection.json").read_text())
    package = ROOT / "exports" / config["export_id"]
    manifest = json.loads((package / "export-manifest.json").read_text())
    expected = {"README.md", "LICENSE", "ATTRIBUTION.md", "export-manifest.json"}
    if "preview" in manifest:
        expected.add(manifest["preview"]["file_name"])
        if sha256(package / manifest["preview"]["file_name"]) != manifest["preview"]["sha256"]:
            raise ValueError("Preview image hash mismatch")
    for row in manifest["rows"]:
        expected.add(row["file_name"])
        expected.add(str(Path(row["file_name"]).parent / "metadata.jsonl"))
        if sha256(package / row["file_name"]) != row["sha256"]:
            raise ValueError("Source image hash mismatch: " + row["sample_id"])
    actual = {str(p.relative_to(package)) for p in package.rglob("*") if p.is_file()}
    if actual != expected:
        raise ValueError("Export membership differs from the allowlisted package")
    if manifest["license"] != config["license"] or manifest["license"] != "cc-by-4.0":
        raise ValueError("Unexpected package license")
    if sha256(package / "LICENSE") != manifest["license_sha256"]:
        raise ValueError("License hash mismatch")
    if (package / "ATTRIBUTION.md").read_bytes() != (ROOT / "publication/ATTRIBUTION.md").read_bytes():
        raise ValueError("Attribution notice differs from the source")
    if args.check:
        print(json.dumps({"package_valid": True, "images": len(manifest["rows"]), "files": len(expected),
                          "license": manifest["license"], "token_available": bool(get_token()), "uploaded": False}, indent=2))
        return
    if not get_token():
        print("Hugging Face login is required. Run .build/hf-dataset-tools/bin/hf auth login locally; do not paste a token into chat.", file=sys.stderr)
        sys.exit(2)
    api = HfApi()
    user = api.whoami()["name"]
    saved_repo = collection.get("huggingface_repository", {})
    namespace = args.namespace or saved_repo.get("repo_id", user + "/").split("/")[0]
    if not namespace or "/" in namespace:
        raise ValueError("Namespace must be one username or organisation")
    repo_id = namespace + "/wonderlines-colouring-sheets"
    requested_private = not (saved_repo.get("repo_id") == repo_id and saved_repo.get("visibility") == "public")
    try:
        existing = api.repo_info(repo_id=repo_id, repo_type="dataset")
    except RepositoryNotFoundError:
        existing = None
    if existing and existing.private != requested_private:
        raise ValueError("Target visibility differs from the saved collection settings")
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=requested_private, exist_ok=True)
    if api.repo_info(repo_id=repo_id, repo_type="dataset").private != requested_private:
        raise ValueError("Repository visibility differs from the saved collection settings")
    print("Uploading " + str(len(expected)) + " files to https://huggingface.co/datasets/" + repo_id, flush=True)
    commit = api.upload_folder(
        repo_id=repo_id, repo_type="dataset", folder_path=str(package), allow_patterns=sorted(expected),
        commit_message="Add 400 synthetic colouring sheets with CC BY 4.0 and age-band configurations",
    )
    # Save the known successful commit before verification, so failures can be recovered without ambiguity.
    receipt_path = ROOT / "reviews" / (config["export_id"] + "-upload.json")
    receipt = {"repo_id": repo_id, "url": "https://huggingface.co/datasets/" + repo_id,
               "private": requested_private, "export_id": config["export_id"], "commit_sha": commit.oid,
               "commit_url": commit.commit_url, "uploaded_at": datetime.now(timezone.utc).isoformat(),
               "images": len(manifest["rows"]), "files": len(expected), "license": config["license"],
               "remote_verified": False, "source_export_manifest_sha256": sha256(package / "export-manifest.json")}
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    info = api.repo_info(repo_id=repo_id, repo_type="dataset", revision=commit.oid, files_metadata=True)
    remote = {f.rfilename: f for f in info.siblings}
    missing = expected - remote.keys()
    extra = remote.keys() - expected - {".gitattributes"}
    if missing or extra:
        raise ValueError("Remote file membership differs: missing=" + str(sorted(missing)) + "; extra=" + str(sorted(extra)))
    for name in sorted(expected):
        local = package / name
        entry = remote[name]
        if entry.size != local.stat().st_size:
            raise ValueError("Remote size mismatch: " + name)
        if entry.lfs is not None:
            reported = entry.lfs.sha256 if hasattr(entry.lfs, "sha256") else entry.lfs["sha256"]
            if reported != sha256(local):
                raise ValueError("Remote SHA-256 mismatch: " + name)
        else:
            blob = local.read_bytes()
            git_sha = hashlib.sha1(b"blob " + str(len(blob)).encode() + b"\0" + blob).hexdigest()
            if entry.blob_id != git_sha:
                raise ValueError("Remote Git blob mismatch: " + name)
    receipt["remote_verified"] = True
    receipt["verified_files"] = len(expected)
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    try:
        main()
    except HfHubHTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "unknown"
        print("Hugging Face request failed with HTTP " + str(status) + ". Check account/token permissions and retry; any completed commit is recorded in the upload receipt.", file=sys.stderr)
        sys.exit(1)
