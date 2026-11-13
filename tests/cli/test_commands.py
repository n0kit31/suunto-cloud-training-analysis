import contextlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from suunto_cloud.cli import main
from tests.fixtures import fixture


ROOT = Path(__file__).resolve().parents[2]


class CommandTests(unittest.TestCase):
    def test_help_for_every_command_requires_no_config_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            clean_root = Path(directory)
            shutil.copytree(ROOT / 'suunto_cloud', clean_root / 'suunto_cloud',
                            ignore=shutil.ignore_patterns('__pycache__'))
            for command in (None, 'sync', 'oauth', 'access', 'workouts', 'track', 'analyze', 'charts'):
                with self.subTest(command=command):
                    args = [sys.executable, '-m', 'suunto_cloud']
                    if command:
                        args.append(command)
                    result = subprocess.run([*args, '--help'], cwd=clean_root, text=True,
                                            capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('usage:', result.stdout)

    def test_legacy_sync_command_works_from_another_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(ROOT / 'sync.py'), '--help'],
                                    cwd=directory, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--date', result.stdout)
        self.assertIn('--analysis', result.stdout)

    def test_missing_date_is_rejected_before_network_access(self):
        result = subprocess.run([sys.executable, '-m', 'suunto_cloud', 'sync'],
                                cwd=ROOT, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--date', result.stderr)

    def test_analyze_command_reads_synthetic_fit_json(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.json'
            source.write_text(json.dumps(fixture()))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = main(['analyze', str(source)])
        self.assertEqual(result, 0)
        analysis = json.loads(output.getvalue())
        self.assertEqual(analysis['additional_metrics']['active']['record_count'], 150)

    def test_analyze_error_does_not_echo_file_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.json'
            source.write_text('test-only-private-content')
            error = io.StringIO()
            with contextlib.redirect_stderr(error):
                result = main(['analyze', str(source)])
        self.assertEqual(result, 1)
        self.assertNotIn('test-only-private-content', error.getvalue())
