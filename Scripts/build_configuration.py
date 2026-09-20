#!/usr/bin/env python3
"""Build a bundled configuration without putting secrets in build settings or logs."""
import os
import plistlib
from pathlib import Path

root = Path(os.environ["SRCROOT"])
mode = os.environ.get("COLORING_MODE", "mock")
release = os.environ.get("CONFIGURATION") == "Release"
if mode not in ("mock", "live"):
    raise SystemExit("error: COLORING_MODE must be mock or live.")
if release and mode != "live":
    raise SystemExit("error: Release requires live configuration and a local Worker credential.")
credential = ""
if mode == "live":
    path = root / ".secrets/worker-password"
    try:
        credential = path.read_text()
    except OSError:
        raise SystemExit("error: Worker credential missing. Run python3 Scripts/setup_secret.py in Terminal.") from None
    if not credential or credential != credential.strip() or any(ord(c) < 33 or ord(c) > 126 for c in credential):
        raise SystemExit("error: Worker credential must be non-empty printable ASCII without spaces.")
output = Path(os.environ["TARGET_BUILD_DIR"]) / os.environ["UNLOCALIZED_RESOURCES_FOLDER_PATH"] / "ServiceConfiguration.plist"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(plistlib.dumps({"credential": credential, "mock": mode == "mock"}, fmt=plistlib.FMT_BINARY))
