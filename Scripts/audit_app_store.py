#!/usr/bin/env python3
"""Check archived submission integrity and flag source changes for manual review."""
import argparse
import fnmatch
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = ROOT / 'docs/app-store/submissions/2026-10-04-1.0-build-2'


def git(*args):
    result = subprocess.run(['git', '-C', str(ROOT), *args], capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace').strip())
    return result.stdout


def paths(raw):
    return {p.decode('utf-8', errors='replace') for p in raw.split(b'\0') if p}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=DEFAULT_BASELINE)
    parser.add_argument('--ref', default='HEAD', help='Git revision to compare with the submitted source commit')
    parser.add_argument('--include-working-tree', action='store_true', help='Also inspect staged, unstaged and untracked paths')
    args = parser.parse_args()
    baseline = args.baseline.resolve()
    try:
        integrity = json.loads((baseline / 'integrity.json').read_text())
        problems = []
        expected = set(integrity['files'])
        for name, digest in integrity['files'].items():
            path = (baseline / name).resolve()
            if not path.is_relative_to(baseline):
                raise ValueError(f'Archive path escapes baseline: {name}')
            if not path.is_file():
                problems.append(f'Missing: {name}')
            elif hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                problems.append(f'Changed: {name}')
        actual = {p.relative_to(baseline).as_posix() for p in baseline.rglob('*')
                  if p.is_file() and p.name not in {'integrity.json', 'review-contact.private.json'}}
        problems.extend(f'Unlisted archive file: {name}' for name in sorted(actual - expected))
        if problems:
            print('Archive verification failed:', *problems, sep='\n  ')
            return 2
        record = json.loads((baseline / 'submission.json').read_text())
        source = record['build']['source_commit']
        changed = paths(git('diff', '--name-only', '-z', '--no-renames', source, args.ref, '--'))
        if args.include_working_tree:
            changed |= paths(git('diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'))
            changed |= paths(git('ls-files', '--others', '--exclude-standard', '-z'))
        print(f"Archive intact: {len(expected)} files; {record['submission']['items'][0]['version']} "
              f"({record['build']['number']}), source {source[:12]}.")
        flagged = False
        for rule in record['audit_rules']:
            hits = sorted(p for p in changed if any(fnmatch.fnmatchcase(p, pattern) for pattern in rule['patterns']))
            if hits:
                flagged = True
                print(f"\nReview {rule['label']}:")
                for path in hits:
                    print(f'  {path}')
        if flagged:
            print('\nCompare these changes with the archived declarations and copy before release. '
                  'See the baseline README for the review checklist.')
            return 1
        print('No covered source changes detected. Check runtime settings and Apple metadata separately; '
              'this is not a compliance certification.')
        return 0
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print(f'Audit failed: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
