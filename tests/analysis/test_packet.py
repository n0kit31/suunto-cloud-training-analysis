import unittest

from suunto_cloud.analysis.packet import build_packet, cloud_metrics, compact_fit
from tests.fixtures import workout


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
