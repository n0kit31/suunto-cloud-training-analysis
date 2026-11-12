from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyze_fit import summarize
from analysis_details import active_samples


def fixture():
    origin = datetime(2026, 11, 5, 16, tzinfo=timezone.utc)
    at = lambda n: (origin + timedelta(seconds=n)).isoformat().replace('+00:00', 'Z')
    rows = []
    for n in range(150):
        work = n < 60
        rows.append({'timestamp': at(n), 'heart_rate': 160 if work else 160 - (n - 60) / 2,
                     'speed': 4 if work else 2, 'cadence': 100 if work else 90,
                     'stance_time': 210 if work else 280, 'vertical_oscillation': 60 if work else 70,
                     'altitude': 50 + n / 100, 'distance': 4 * n if work else 240 + 2 * (n - 60),
                     'estimate': 14000 + n})
    laps = [{'event': 'lap', 'lap_trigger': 'distance', 'start_time': at(0), 'timestamp': at(150),
             'total_distance': 420, 'total_timer_time': 150},
            {'event': 'workout_step', 'lap_trigger': 'fitness_equipment', 'start_time': at(0),
             'timestamp': at(60), 'total_distance': 240, 'total_timer_time': 60},
            {'event': 'workout_step', 'lap_trigger': 'fitness_equipment', 'start_time': at(60),
             'timestamp': at(150), 'total_distance': 180, 'total_timer_time': 90}]
    return {'sessions': [{'start_time': at(0), 'timestamp': at(150), 'sport': 'running'}],
            'events': [{'event': 'timer', 'event_type': 'start', 'timestamp': at(0)},
                       {'event': 'timer', 'event_type': 'stop', 'timestamp': at(150)}],
            'records': rows, 'laps': laps,
            'field_descriptions': [{'field_name': 'estimate', 'units': 's',
                                    'suuntoplus_field_label': 'Marathon time(est)'}]}


class AdditionalMetricsTests(unittest.TestCase):
    def test_guided_laps_units_and_recovery_are_independent_of_auto_laps(self):
        data = fixture()
        details = summarize(data)['additional_metrics']
        self.assertEqual(details['preferred_lap_indices'], [2, 3])
        work = details['lap_samples'][0]['mechanics']
        self.assertEqual(work['cadence_steps_per_min'], 200)
        self.assertEqual(work['ground_contact_ms'], 210)
        self.assertEqual(work['vertical_oscillation_cm'], 6)
        self.assertAlmostEqual(work['estimated_step_length_m'], 1.2)
        recovery = details['slower_next_lap_hr_changes'][0]
        self.assertEqual(recovery['hr_drop_after_60_seconds'], 30)
        self.assertEqual(details['suuntoplus_channels'][0]['last_active_value'], 14149)
        self.assertEqual(len(data['records']), 150)

    def test_pause_samples_are_excluded_and_do_not_form_a_recovery_test(self):
        data = fixture()
        at = lambda n: data['records'][n]['timestamp']
        data['events'][1:1] = [{'event': 'timer', 'event_type': 'stop', 'timestamp': at(90)},
                              {'event': 'timer', 'event_type': 'start', 'timestamp': at(120)}]
        data['records'][100]['heart_rate'] = 250
        result = summarize(data)
        details = result['additional_metrics']
        self.assertEqual(len(active_samples(data, result['timer'])), 120)
        self.assertEqual(result['hr_peak_records_active_only'][0]['heart_rate'], 160)
        self.assertTrue(details['slower_next_lap_hr_changes'][0]['pause_in_next_lap'])
        self.assertIsNone(details['slower_next_lap_hr_changes'][0]['hr_drop_after_60_seconds'])

    def test_missing_heart_rate_is_not_carried_forward_across_a_gap(self):
        data = fixture()
        for n in range(117, 122):
            del data['records'][n]['heart_rate']
        recovery = summarize(data)['additional_metrics']['slower_next_lap_hr_changes'][0]
        self.assertIsNone(recovery['hr_after_60_elapsed_seconds'])
        self.assertIsNone(recovery['hr_drop_after_60_seconds'])

    def test_recovery_uses_observation_at_the_actual_transition_timestamp(self):
        data = fixture()
        data['records'][60]['heart_rate'] = 158
        recovery = summarize(data)['additional_metrics']['slower_next_lap_hr_changes'][0]
        self.assertEqual(recovery['hr_at_work_end']['bpm'], 158)
        self.assertEqual(recovery['hr_drop_after_60_seconds'], 28)

    def test_duplicate_timestamps_and_missing_mechanics_remain_observed_data(self):
        data = fixture()
        data['records'].append({'timestamp': data['records'][30]['timestamp'], 'heart_rate': 155})
        del data['records'][0]['cadence']
        details = summarize(data)['additional_metrics']
        self.assertEqual(details['active']['record_count'], 151)
        self.assertEqual(details['active']['mechanics_paired_count'], 149)


if __name__ == '__main__':
    unittest.main()
