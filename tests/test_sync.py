import contextlib
from datetime import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sync
from analysis_packet import build_packet, cloud_metrics, compact_fit


def workout(key='a' * 24, day='2026-11-11', activity=1):
    start = int(datetime.fromisoformat(day + 'T08:00:00+00:00').timestamp() * 1000)
    return {'workoutKey': key, 'activityId': activity, 'startTime': start, 'stopTime': start + 1200000,
            'totalTime': 600, 'totalDistance': 2000, 'hrdata': {'workoutAvgHR': 130, 'workoutMaxHR': 145,
                                                            'userMaxHR': 187, 'max': 187},
            'tss': {'calculationMethod': 'HR', 'trainingStressScore': 10},
            'extensions': [{'type': 'SummaryExtension', 'pte': 2, 'ascent': 12.3},
                           {'type': 'FitnessExtension', 'maxHeartRate': 187, 'estimatedVo2Max': 52}]}


def decoded():
    return {'sessions': [{'total_timer_time': 600, 'total_elapsed_time': 1200,
                          'total_distance': 2000, 'avg_heart_rate': 130, 'max_heart_rate': 145}],
            'events': [{'event': 'timer', 'event_type': kind, 'timestamp': at}
                       for kind, at in [('start', '2026-11-11T08:00:00Z'),
                                        ('stop', '2026-11-11T08:05:00Z'),
                                        ('start', '2026-11-11T08:15:00Z'),
                                        ('stop', '2026-11-11T08:20:00Z')]],
            'records': [{'timestamp': '2026-11-11T08:01:00Z', 'heart_rate': 130},
                        {'timestamp': '2026-11-11T08:10:00Z', 'heart_rate': 180},
                        {'timestamp': '2026-11-11T08:16:00Z', 'heart_rate': 145}]}


class AnalysisPacketTests(unittest.TestCase):
    def test_metrics_use_active_pace_and_measured_maximum(self):
        result = cloud_metrics(workout())
        self.assertEqual(result['pace_seconds_per_km'], 300)
        self.assertEqual(result['elapsed_seconds'], 1200)
        self.assertEqual(result['max_hr_bpm'], 145)
        self.assertEqual(result['fitness']['maxHeartRate'], 187)

    def test_peak_preview_is_bounded_and_original_is_preserved(self):
        analysis = {'hr_peak_records_active_only': [{'timestamp': str(i)} for i in range(1000)],
                    'laps': [{'trigger': 'workout_step'}, {'trigger': 'distance'}]}
        result = compact_fit(analysis)
        self.assertEqual(result['hr_peak']['sample_count'], 1000)
        self.assertEqual(len(result['hr_peak']['samples_preview']), 5)
        self.assertEqual(result['hr_peak']['last']['timestamp'], '999')
        self.assertEqual(len(analysis['hr_peak_records_active_only']), 1000)
        self.assertEqual(result['laps'], analysis['laps'])

    def test_comparisons_exclude_later_and_different_sports(self):
        selected = workout()
        previous = workout('b' * 24, '2026-11-10')
        later = workout('c' * 24, '2026-11-12')
        other = workout('d' * 24, '2026-11-09', 2)
        entry = {'workout_key': selected['workoutKey'], **{k: 'test' for k in
                 ('cloud_summary_path', 'fit_path', 'decoded_path', 'analysis_path')}}
        result = build_packet({'workouts': [entry], 'retrieved_at_utc': 'now', 'complete': True,
                               'requested_dates': ['2026-11-11']},
                              [selected, previous, later, other], {selected['workoutKey']: {}})
        self.assertEqual([w['workout_key'] for w in result['comparison_candidates']], [previous['workoutKey']])
        self.assertFalse(result['history_completeness_verified'])


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
        self.decoder = self.stack.enter_context(patch.object(sync.subprocess, 'run', side_effect=self.decode))

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

    def test_network_failure_produces_no_success_output(self):
        self.fetch_list.side_effect = URLError('DNS unavailable')
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(URLError):
            sync.sync(['2026-11-11'], analysis=True)
        self.assertEqual(output.getvalue(), '')
        self.fetch_fit.assert_not_called()

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

    def test_explicit_chart_request_generates_svg(self):
        with contextlib.redirect_stdout(io.StringIO()):
            manifest = sync.sync(['2026-11-11'], analysis=True, charts=True)
        self.assertTrue(Path(manifest['workouts'][0]['outputs']['chart_path']).is_file())


if __name__ == '__main__':
    unittest.main()
