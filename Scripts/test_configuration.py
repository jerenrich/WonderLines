#!/usr/bin/env python3
"""Exercise public service configuration in an isolated temporary tree."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

script = Path(__file__).with_name('build_configuration.py').resolve()
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    env = dict(os.environ, SRCROOT=directory, TARGET_BUILD_DIR=directory, UNLOCALIZED_RESOURCES_FOLDER_PATH='Test.app')
    def run(mode, configuration, url=None):
        extra = {} if url is None else {'COLORING_SERVICE_URL': url}
        return subprocess.run(['/usr/bin/python3', str(script)], env=dict(env, COLORING_MODE=mode, CONFIGURATION=configuration, **extra), capture_output=True)
    assert run('mock', 'Debug').returncode == 0
    assert run('mock', 'Release').returncode == 0
    assert run('live', 'Release').returncode == 0
    for invalid in ['http://not-https.example', 'https:', 'https://', 'https://example.test/',
                    'https://example.test/path', 'https://example.test?query', 'https://example.test#fragment',
                    'https://user:password@example.test', 'https://example.test:99999', 'https://example.test\n']:
        assert run('live', 'Release', invalid).returncode != 0, invalid
    config = plistlib.loads((root/'Test.app/ServiceConfiguration.plist').read_bytes())
    assert config == {'mock':False, 'serviceURL':'https://coloring-sheets-api.jordan-erenrich.workers.dev'}
print('PASS: public service configuration is valid for mock and live builds; invalid origins fail.')
