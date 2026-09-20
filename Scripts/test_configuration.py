#!/usr/bin/env python3
"""Exercise build-secret injection using only a dummy in an isolated temporary tree."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

script = Path(__file__).with_name('build_configuration.py').resolve()
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    env = dict(os.environ, SRCROOT=directory, TARGET_BUILD_DIR=directory, UNLOCALIZED_RESOURCES_FOLDER_PATH='Test.app')
    def run(mode, configuration):
        return subprocess.run(['/usr/bin/python3', str(script)], env=dict(env, COLORING_MODE=mode, CONFIGURATION=configuration), capture_output=True)
    assert run('mock', 'Debug').returncode == 0
    assert run('mock', 'Release').returncode != 0
    assert run('live', 'Release').returncode != 0
    (root/'.secrets').mkdir()
    dummy = 'synthetic-test-only-never-real'
    (root/'.secrets/worker-password').write_text(dummy)
    result = run('live', 'Release')
    assert result.returncode == 0
    assert dummy.encode() not in result.stdout + result.stderr
    config = plistlib.loads((root/'Test.app/ServiceConfiguration.plist').read_bytes())
    assert config == {'credential':dummy,'mock':False}
print('PASS: missing Release secret fails; mock stays empty; dummy injection is silent.')
