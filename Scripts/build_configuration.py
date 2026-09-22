#!/usr/bin/env python3
"""Build the public service configuration without putting credentials in the app."""
import os
import plistlib
from pathlib import Path
from urllib.parse import urlsplit

mode = os.environ.get("COLORING_MODE", "mock")
if mode not in ("mock", "live"):
    raise SystemExit("error: COLORING_MODE must be mock or live.")
service_url = os.environ.get("COLORING_SERVICE_URL", "https://coloring-sheets-api.jordan-erenrich.workers.dev")
try:
    origin = urlsplit(service_url)
    valid_origin = (origin.scheme == "https" and bool(origin.hostname)
                    and origin.username is None and origin.password is None
                    and not origin.path and not origin.query and not origin.fragment
                    and "?" not in service_url and "#" not in service_url
                    and not any(character.isspace() for character in service_url)
                    and (origin.port is None or 1 <= origin.port <= 65535))
except ValueError:
    valid_origin = False
if not valid_origin:
    raise SystemExit("error: COLORING_SERVICE_URL must be an HTTPS origin without a trailing slash.")
output = Path(os.environ["TARGET_BUILD_DIR"]) / os.environ["UNLOCALIZED_RESOURCES_FOLDER_PATH"] / "ServiceConfiguration.plist"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(plistlib.dumps({"mock": mode == "mock", "serviceURL": service_url}, fmt=plistlib.FMT_BINARY))
