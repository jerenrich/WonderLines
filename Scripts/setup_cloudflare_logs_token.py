#!/usr/bin/env python3
"""Save a Cloudflare observability token without displaying it."""
import getpass
import os
from pathlib import Path

token = getpass.getpass("Cloudflare observability API token (hidden): ")
if not token or token != token.strip() or any(ord(c) < 33 or ord(c) > 126 for c in token):
    raise SystemExit("Enter a non-empty token without spaces.")
folder = Path(__file__).resolve().parents[1] / ".secrets"
folder.mkdir(mode=0o700, exist_ok=True)
os.chmod(folder, 0o700)
path = folder / "cloudflare-observability-token"
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit("A token file already exists; it was not changed.")
with os.fdopen(fd, "w") as output:
    output.write(token)
print("Token saved locally; its value was not displayed.")
