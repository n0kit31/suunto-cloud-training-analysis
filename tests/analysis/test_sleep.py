from copy import deepcopy
from datetime import datetime, timedelta
import unittest
from zoneinfo import ZoneInfo

from suunto_cloud.analysis.sleep import recovery_context, sleep_records


def night(day='2026-01-15', hrv=50, **changes):
    end = datetime.fromisoformat(day + 'T07:00:00+01:00')
    data = {'SleepId': day, 'BedtimeStart': (end - timedelta(hours=8)).isoformat(),
            'BedtimeEnd': end.isoformat(), 'IsNap': False, 'Duration': 28800,
            'AvgHRV': hrv, 'AvgHRVSampleCount': 80, 'HRAvg': 55, 'HRMin': 50,
            'SleepQualityScore': 75}
    data.update(changes)
    return {'timestamp': data['BedtimeStart'], 'entryData': data}


def snapshot(rows):
    return {'source': 'official_suunto_mcp', 'retrieved_at_utc': '2026-01-17T12:00:00Z', 'data': rows}


def workout():
    return {'start_local': '2026-01-15T18:00:00+01:00',
            'stop_local': '2026-01-15T19:00:00+01:00', 'timezone': 'Europe/Warsaw'}


class SleepTests(unittest.TestCase):
    def test_selects_the_night_before_and_separates_the_night_after(self):
        rows = [night(), night('2026-01-16', hrv=40)]
        result = recovery_context(workout(), snapshot(rows))
        self.assertEqual(result['before']['hrv_ms'], 50)
        self.assertEqual(result['after']['hrv_ms'], 40)
        self.assertEqual(result['after_hrv_change_ms'], -10)
        self.assertEqual(result['hrv_7d']['night_count'], 1)
        self.assertIsNone(result['hrv_7d']['average_ms'])

    def test_deduplicates_and_prefers_complete_snapshot_over_partial_updates(self):
        full = night()
        partial = deepcopy(full)
        del partial['entryData']['AvgHRV']
        result = recovery_context(workout(), snapshot([full, full, partial]))
        self.assertEqual(result['before']['hrv_ms'], 50)
        self.assertEqual(result['hrv_7d']['night_count'], 1)

    def test_excludes_naps_and_stale_nights(self):
        result = recovery_context(workout(), snapshot([night('2026-01-13'), night(IsNap=True)]))
        self.assertIsNone(result['before'])

    def test_early_workout_does_not_use_a_sleep_that_has_not_finished(self):
        cloud = workout()
        cloud['start_local'] = '2026-01-15T06:00:00+01:00'
        cloud['stop_local'] = '2026-01-15T06:30:00+01:00'
        result = recovery_context(cloud, snapshot([night('2026-01-14'), night()]))
        self.assertEqual(result['before']['wake_date'], '2026-01-14')
        self.assertEqual(result['hrv_7d']['night_count'], 1)
        self.assertIsNone(result['after'])  # Sleep overlapping the workout is not its reaction.

    def test_calendar_window_does_not_substitute_older_nights_for_missing_days(self):
        rows = [night('2026-01-01'), night('2026-01-09', hrv=30),
                night('2026-01-13', hrv=40), night(hrv=80)]
        result = recovery_context(workout(), snapshot(rows))
        self.assertEqual(result['hrv_7d']['night_count'], 3)
        self.assertEqual(result['hrv_7d']['average_ms'], 50)

    def test_missing_invalid_hrv_and_zero_samples_are_not_zero_measurements(self):
        rows = [night('2026-01-09', hrv=0), night('2026-01-10', hrv=-2),
                night('2026-01-11', hrv=float('nan')), night('2026-01-12', hrv=True),
                night('2026-01-13', AvgHRVSampleCount=0), night(hrv=None)]
        result = recovery_context(workout(), snapshot(rows))
        self.assertEqual(result['hrv_7d']['night_count'], 0)
        self.assertIsNone(result['before']['hrv_ms'])

    def test_reference_requires_fourteen_nights_and_excludes_current_and_future_sleep(self):
        rows = [night(f'2026-01-{day:02d}', hrv=day * 2) for day in range(1, 15)]
        result = recovery_context(workout(), snapshot(rows + [night(hrv=999), night('2026-01-16', hrv=1000)]))
        reference = result['reference_60d']
        self.assertEqual(reference['night_count'], 14)
        self.assertEqual(reference['median_ms'], 15)
        self.assertAlmostEqual(reference['low_ms'], 4.6)
        self.assertAlmostEqual(reference['high_ms'], 25.4)
        self.assertIsNone(recovery_context(workout(), snapshot(rows[1:]))['reference_60d'])

    def test_multiple_main_sleeps_on_one_date_do_not_overweight_averages(self):
        shorter = night('2026-01-14', hrv=100, SleepId='other', Duration=3600)
        result = recovery_context(workout(), snapshot([night('2026-01-14', hrv=40), shorter, night(hrv=50)]))
        self.assertEqual(result['hrv_7d']['night_count'], 2)

    def test_uses_sleep_stages_without_counting_awake_time_as_sleep(self):
        row = night(Duration=30000, DeepSleepDuration=6000, LightSleepDuration=15000, REMSleepDuration=6000)
        result = recovery_context(workout(), snapshot([row]))
        self.assertEqual(result['before']['sleep_seconds'], 27000)
        self.assertEqual(result['before']['duration_method'], 'sum_of_sleep_stages')

    def test_time_zone_offsets_and_dst_use_local_wake_dates(self):
        cloud = {'start_local': '2026-10-25T18:00:00+01:00', 'stop_local': '2026-10-25T19:00:00+01:00',
                 'timezone': 'Europe/Warsaw'}
        row = night('2026-10-25', BedtimeStart='2026-10-24T23:00:00+02:00',
                    BedtimeEnd='2026-10-25T06:00:00Z')
        result = recovery_context(cloud, snapshot([row]))
        self.assertEqual(result['before']['wake_date'], '2026-10-25')
        self.assertEqual(result['before']['end'], '2026-10-25T07:00:00+01:00')

    def test_invalid_or_naive_timestamps_are_skipped_without_inventing_a_time_zone(self):
        rows = [night(BedtimeEnd='invalid'), night(BedtimeStart='2026-01-15T07:00:00'),
                night(BedtimeEnd='2026-01-13T07:00:00+01:00')]
        self.assertEqual(sleep_records(snapshot(rows), ZoneInfo('Europe/Warsaw')), [])

    def test_absent_dataset_preserves_reports_without_a_recovery_card(self):
        self.assertIsNone(recovery_context(workout(), None))
