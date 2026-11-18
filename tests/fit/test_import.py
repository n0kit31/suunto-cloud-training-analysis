import contextlib
from datetime import timezone
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from suunto_cloud.cli import main
from suunto_cloud.fit import import_command
from tests.fixtures import fixture


class LocalFitImportTests(unittest.TestCase):
    def test_import_and_chart_regeneration_keep_cloud_report_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            local = project / 'suunto-cloud' / '.local'
            local.mkdir(parents=True)
            source = local / 'workout.fit'
            source.write_bytes(b'synthetic FIT bytes')
            data = fixture()
            data['sessions'][0].update(total_timer_time=150, total_elapsed_time=150,
                                       total_distance=420, avg_heart_rate=140)

            def decode(input_path, output_path):
                self.assertEqual(input_path.read_bytes(), source.read_bytes())
                output_path.write_text(json.dumps(data))
                return data

            reports = project / 'reports'
            reports.mkdir()
            cloud_report = reports / 'suunto-2026-11-05-160000.json'
            cloud_report.write_text('{"existing_cloud_report": true}')
            with (patch.object(import_command, 'ROOT', local.parent),
                  patch.object(import_command, 'private_directory', return_value=local),
                  patch.object(import_command, 'user_timezone', return_value=timezone.utc),
                  patch.object(import_command, 'decode_fit', side_effect=decode),
                  patch('suunto_cloud.authentication.access.authorized_call',
                        side_effect=AssertionError('Offline commands cannot request access')),
                  contextlib.redirect_stdout(io.StringIO()) as stdout):
                self.assertEqual(main(['import-fit', str(source)]), 0)
                out = json.loads(stdout.getvalue())
                self.assertEqual(main(['charts', out['json_path']]), 0)
            report = json.loads(Path(out['json_path']).read_text())
            self.assertEqual(report['cloud']['distance_m'], 420)
            self.assertIsNone(report['cloud']['workout_key'])
            self.assertIsNone(report['cloud']['tss'])
            self.assertEqual(report['source']['fit_sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertTrue(Path(report['source']['decoded_path']).is_file())
            self.assertTrue(Path(report['chart_path']).is_file())
            self.assertEqual(json.loads(cloud_report.read_text()), {'existing_cloud_report': True})
