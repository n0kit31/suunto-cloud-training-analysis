import contextlib
import fcntl
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import URLError
from zoneinfo import ZoneInfo

from suunto_cloud.synchronization import service as sync
from tests.fixtures import decoded, workout
from suunto_cloud.timezones import TimeZoneError
from tests.analysis.test_sleep import night, snapshot





class SyncAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(sync, 'private_directory', return_value=self.root))
        self.stack.enter_context(patch.object(sync, 'ROOT', self.root / 'suunto-cloud'))
        self.stack.enter_context(patch.object(sync, 'save_workouts'))
        self.stack.enter_context(patch.object(sync, 'authorized_call', side_effect=lambda operation: operation('token', 'key')))
        self.fetch_list = self.stack.enter_context(patch.object(sync, 'fetch_workouts', return_value={'payload': [workout()]}))
        self.fetch_fit = self.stack.enter_context(patch.object(sync, 'fetch_fit', return_value=b'header00.FIT00'))
        self.decoder = self.stack.enter_context(patch('suunto_cloud.fit.subprocess.run', side_effect=self.decode))

    def decode(self, command, **kwargs):
        Path(command[-1]).write_text(json.dumps(decoded()))
        return MagicMock(returncode=0)

    def test_one_run_outputs_fresh_compact_data_and_preserves_full_samples(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manifest = sync.sync(['2026-11-11'], analysis=True)
        packet = json.loads(output.getvalue())
        self.assertTrue(manifest['complete'])
        self.assertEqual(len(packet['workouts']), 1)
        fit = packet['workouts'][0]['fit']
        self.assertEqual(fit['hr_peak']['first']['heart_rate'], 145)  # Excludes pause HR=180.
        self.assertEqual(fit['timer']['pause_seconds_from_rounded_events'], 600)
        self.assertEqual(fit['record_count'], 3)
        self.assertEqual(len(json.loads(Path(manifest['workouts'][0]['decoded_path']).read_text())['records']), 3)
        self.assertEqual(json.loads((self.root / 'analysis.json').read_text()), packet)
        self.fetch_list.assert_called_once()
        self.fetch_fit.assert_called_once()
        self.decoder.assert_called_once()

    def test_decoder_failure_does_not_publish_stale_analysis_as_success(self):
        (self.root / 'analysis.json').write_text('{"previous": true}')
        self.decoder.side_effect = lambda *a, **k: MagicMock(returncode=1)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(sync.AccessError):
                sync.sync(['2026-11-11'], analysis=True)
        manifest = json.loads((self.root / 'sync.json').read_text())
        self.assertFalse(manifest['complete'])
        self.assertNotIn('analysis_packet_path', manifest)
        self.assertEqual(json.loads((self.root / 'analysis.json').read_text()), {'previous': True})

    def test_workouts_with_the_same_start_keep_distinct_artifacts_across_runs(self):
        first, second = workout(), workout('b' * 24)
        first_fit, second_fit = b'first synthetic FIT', b'second synthetic FIT'
        self.fetch_fit.side_effect = [first_fit, second_fit, first_fit, second_fit]
        self.fetch_list.return_value = {'payload': [first]}
        with contextlib.redirect_stdout(io.StringIO()):
            previous = sync.sync(['2026-11-11'], analysis=True, charts=True, zone=ZoneInfo('UTC'))
            self.fetch_list.return_value = {'payload': [second]}
            sync.sync(['2026-11-11'], analysis=True, charts=True, zone=ZoneInfo('UTC'))
            self.assertEqual(Path(previous['workouts'][0]['fit_path']).read_bytes(), first_fit)
            self.fetch_list.return_value = {'payload': [first, second]}
            manifest = sync.sync(['2026-11-11'], analysis=True, charts=True, zone=ZoneInfo('UTC'))

        one, two = manifest['workouts']
        for field in ('fit_path', 'decoded_path', 'analysis_path'):
            self.assertNotEqual(one[field], two[field], field)
            self.assertEqual(one[field], previous['workouts'][0][field])
        for field in ('json_path', 'markdown_path', 'chart_path', 'svg_path'):
            self.assertNotEqual(one['outputs'][field], two['outputs'][field], field)
            self.assertEqual(one['outputs'][field], previous['workouts'][0]['outputs'][field])
        for entry, content in zip((one, two), (first_fit, second_fit)):
            self.assertEqual(Path(entry['fit_path']).read_bytes(), content)
            report = json.loads(Path(entry['outputs']['json_path']).read_text())
            self.assertEqual(report['cloud']['workout_key'], entry['workout_key'])
            self.assertEqual(report['source']['decoded_path'], entry['decoded_path'])

    def test_report_write_failure_records_partial_progress_and_allows_retry(self):
        second = workout('b' * 24)
        second['startTime'] += 3_600_000
        second['stopTime'] += 3_600_000
        self.fetch_list.return_value = {'payload': [workout(), second]}
        packet = self.root / 'analysis.json'
        packet.write_text('{"previous": true}')
        write_outputs = sync.write_outputs

        def fail_second(project, cloud, *args, **kwargs):
            if cloud['workout_key'] == second['workoutKey']:
                raise OSError('synthetic write failure')
            return write_outputs(project, cloud, *args, **kwargs)

        output = io.StringIO()
        with patch.object(sync, 'write_outputs', side_effect=fail_second):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(sync.AccessError):
                    sync.sync(['2026-11-11'], analysis=True, charts=True)
        self.assertEqual(output.getvalue(), '')
        manifest = json.loads((self.root / 'sync.json').read_text())
        self.assertFalse(manifest['complete'])
        self.assertNotIn('analysis_packet_path', manifest)
        self.assertEqual(json.loads(packet.read_text()), {'previous': True})
        first, failed = manifest['workouts']
        self.assertTrue(Path(first['outputs']['json_path']).is_file())
        self.assertEqual(failed['failed_stage'], 'report')
        self.assertNotIn('synthetic write failure', failed['error'])
        self.assertNotIn('outputs', failed)

        with contextlib.redirect_stdout(io.StringIO()):
            retried = sync.sync(['2026-11-11'], analysis=True, charts=True)
        self.assertTrue(retried['complete'])
        self.assertEqual(retried['workouts'][0]['outputs'], first['outputs'])
        self.assertTrue(json.loads(packet.read_text())['complete'])

    def test_packet_write_failure_leaves_reports_recorded_and_previous_packet_intact(self):
        packet = self.root / 'analysis.json'
        packet.write_text('{"previous": true}')
        private_json = sync.private_json

        def fail_packet(destination, data):
            if destination == packet:
                raise OSError('synthetic packet failure')
            return private_json(destination, data)

        output = io.StringIO()
        with patch.object(sync, 'private_json', side_effect=fail_packet):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(sync.AccessError):
                    sync.sync(['2026-11-11'], analysis=True)
        manifest = json.loads((self.root / 'sync.json').read_text())
        self.assertFalse(manifest['complete'])
        self.assertEqual(manifest['failed_stage'], 'analysis_packet')
        self.assertTrue(Path(manifest['workouts'][0]['outputs']['json_path']).is_file())
        self.assertEqual(json.loads(packet.read_text()), {'previous': True})
        self.assertEqual(output.getvalue(), '')

    def test_network_failure_produces_no_success_output(self):
        self.fetch_list.side_effect = URLError('DNS unavailable')
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(URLError):
            sync.sync(['2026-11-11'], analysis=True)
        self.assertEqual(output.getvalue(), '')
        self.fetch_fit.assert_not_called()

    def test_parallel_sync_cannot_replace_an_active_runs_manifest(self):
        manifest = self.root / 'sync.json'
        manifest.write_text('{"active_run": true}')
        with (self.root / 'sync.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(sync.AccessError, 'Another sync is already running'):
                sync.sync(['2026-11-11'], analysis=True)
        self.assertEqual(json.loads(manifest.read_text()), {'active_run': True})
        self.fetch_list.assert_not_called()

    def test_analysis_without_decoding_is_rejected_before_network(self):
        with self.assertRaises(ValueError):
            sync.sync(['2026-11-11'], decode=False, analysis=True)
        self.fetch_list.assert_not_called()

    def test_brief_view_preserves_full_packet_and_default_has_no_charts(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manifest = sync.sync(['2026-11-11'], analysis=True, brief=True)
        brief = json.loads(output.getvalue())
        full = json.loads((self.root / 'analysis.json').read_text())
        self.assertEqual(brief['workout_keys'], full['workout_keys'])
        self.assertIn('brief-v1', brief['view'])
        self.assertIn('additional_metrics', full['workouts'][0]['fit'])
        self.assertTrue(Path(manifest['workouts'][0]['outputs']['markdown_path']).is_file())
        self.assertIsNone(manifest['workouts'][0]['outputs']['chart_path'])
        self.assertFalse((self.root / 'visualizations').exists())

    def test_charts_require_analysis_before_any_network_call(self):
        with self.assertRaises(ValueError):
            sync.sync(['2026-11-11'], charts=True)
        self.fetch_list.assert_not_called()

    def test_explicit_chart_request_includes_other_week_workouts_without_downloading_their_fit(self):
        self.fetch_list.return_value = {'payload': [workout(), workout('b' * 24, '2026-11-09')]}
        with contextlib.redirect_stdout(io.StringIO()):
            manifest = sync.sync(['2026-11-11'], analysis=True, charts=True)
        out = manifest['workouts'][0]['outputs']
        self.assertTrue(Path(out['chart_path']).is_file())
        saved = json.loads(Path(out['json_path']).read_text())
        self.assertEqual(len(saved['chart_summary']['week']['comparable']), 2)
        self.assertEqual(saved['chart_summary']['week']['totals']['distance_m'], 4000)
        self.fetch_fit.assert_called_once()

    def test_private_sleep_snapshot_is_in_full_brief_and_saved_reports(self):
        source = self.root / 'sleep.json'
        source.write_text(json.dumps(snapshot([night('2026-11-11', hrv=60)])))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manifest = sync.sync(['2026-11-11'], analysis=True, brief=True, charts=True)
        brief = json.loads(output.getvalue())
        full = json.loads((self.root / 'analysis.json').read_text())
        recovery = brief['workouts'][0]['recovery']
        self.assertEqual(recovery['before']['hrv_ms'], 60)
        self.assertEqual(full['workouts'][0]['recovery'], recovery)
        saved = json.loads(Path(manifest['workouts'][0]['outputs']['json_path']).read_text())
        self.assertEqual(saved['recovery'], recovery)

    def test_explicit_invalid_sleep_is_rejected_before_downloading_workouts(self):
        source = self.root / 'invalid-sleep.json'
        source.write_text('{"data": "invalid"}')
        with self.assertRaises(ValueError):
            sync.sync(['2026-11-11'], analysis=True, sleep_data=source)
        self.fetch_list.assert_not_called()

    def test_user_timezone_is_consistent_in_selection_filenames_and_reports(self):
        with contextlib.redirect_stdout(io.StringIO()):
            manifest = sync.sync(['2026-11-10'], analysis=True, zone=ZoneInfo('Pacific/Honolulu'))
        entry = manifest['workouts'][0]
        self.assertEqual(manifest['timezone'], 'Pacific/Honolulu')
        self.assertEqual(entry['date'], '2026-11-10')
        self.assertTrue(Path(entry['fit_path']).name.startswith('2026-11-10-220000-'))
        packet = json.loads((self.root / 'analysis.json').read_text())
        self.assertEqual(packet['workouts'][0]['cloud']['start_local'], '2026-11-10T22:00:00-10:00')
        self.assertEqual(packet['workouts'][0]['fit']['timezone'], 'Pacific/Honolulu')
        self.assertIn('timezone Pacific/Honolulu;', Path(entry['outputs']['markdown_path']).read_text())

    def test_invalid_timezone_is_rejected_before_network_access(self):
        with patch.object(sync, 'user_timezone', side_effect=TimeZoneError('Unknown time zone.')):
            with self.assertRaises(TimeZoneError):
                sync.main(['--date', '2026-11-11'])
        self.fetch_list.assert_not_called()


if __name__ == '__main__':
    unittest.main()
