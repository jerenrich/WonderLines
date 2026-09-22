#!/usr/bin/env python3
"""Build the public service configuration without putting credentials in the app."""
import os
import plistlib
from pathlib import Path

mode = os.environ.get("COLORING_MODE", "mock")
if mode not in ("mock", "live"):
    raise SystemExit("error: COLORING_MODE must be mock or live.")
service_url = os.environ.get("COLORING_SERVICE_URL", "https://coloring-sheets-api.jordan-erenrich.workers.dev")
if not service_url.startswith("https://") or service_url.rstrip("/") != service_url:
    raise SystemExit("error: COLORING_SERVICE_URL must be an HTTPS origin without a trailing slash.")
output = Path(os.environ["TARGET_BUILD_DIR"]) / os.environ["UNLOCALIZED_RESOURCES_FOLDER_PATH"] / "ServiceConfiguration.plist"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(plistlib.dumps({"mock": mode == "mock", "serviceURL": service_url}, fmt=plistlib.FMT_BINARY))
