#!/usr/bin/env python3
"""Save the direct TypeSafe API key without echoing it or overwriting a key."""
import getpass
import os
from pathlib import Path

secret = getpass.getpass("TypeSafe API key (hidden): ")
if not secret or secret != secret.strip() or any(ord(c) < 33 or ord(c) > 126 for c in secret):
    raise SystemExit("Enter a non-empty key without spaces.")
folder = Path(__file__).resolve().parents[1] / ".secrets"
folder.mkdir(mode=0o700, exist_ok=True)
os.chmod(folder, 0o700)
path = folder / "typesafe-api-key"
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit("A TypeSafe key file already exists; it was not changed.")
with os.fdopen(fd, "w") as output:
    output.write(secret)
print("TypeSafe key saved locally; its value was not displayed.")
