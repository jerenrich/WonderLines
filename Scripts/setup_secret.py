#!/usr/bin/env python3
"""Run interactively in Terminal. Never pass a credential on the command line."""
import getpass
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
secret = getpass.getpass("Worker APP_PASSWORD (hidden; not the OpenAI key): ")
if not secret or secret != secret.strip() or any(ord(c) < 33 or ord(c) > 126 for c in secret):
    raise SystemExit("Use a non-empty printable ASCII Worker password with no spaces.")
folder = root / ".secrets"
folder.mkdir(mode=0o700, exist_ok=True)
os.chmod(folder, 0o700)
path = folder / "worker-password"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(secret)
os.chmod(path, 0o600)
print("Worker credential saved locally. Its value was not printed.")
