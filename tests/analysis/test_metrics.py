import unittest

from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.metrics import active_samples


from tests.fixtures import fixture


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
