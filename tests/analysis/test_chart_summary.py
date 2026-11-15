from copy import deepcopy
from unittest import TestCase
from zoneinfo import ZoneInfo

from suunto_cloud.analysis.chart_summary import chart_summary, split_pattern
from suunto_cloud.analysis.packet import cloud_metrics
from tests.fixtures import workout


def run(key, day, distance=3000, duration=1000, load=20, activity=1):
    raw = workout(key * 24, day, activity)
    raw.update(totalDistance=distance, totalTime=duration,
               tss={'calculationMethod': 'HR', 'trainingStressScore': load})
    return cloud_metrics(raw, ZoneInfo('Europe/Warsaw'))


class ChartSummaryTests(TestCase):
    def test_calendar_week_deduplicates_sources_and_separates_walks(self):
        current = run('a', '2026-11-15', 5000, 1500, 30)
        earlier = run('b', '2026-11-10', activity=22)
        walk = run('c', '2026-11-11', 1000, 600, 5, activity=11)
        outside = run('d', '2026-11-08', 10000, 3600, 90)
        later = run('e', '2026-11-16', 10000, 3600, 90)
        stale = deepcopy(current)
        stale['distance_m'] = 99999
        summary = chart_summary(current, {}, [earlier, earlier, walk, outside, later, stale])
        week = summary['week']
        self.assertEqual((week['from'], week['to']), ('2026-11-09', '2026-11-15'))
        self.assertEqual(len(week['sessions']), 3)
        self.assertEqual(len(week['comparable']), 2)
        self.assertEqual(week['totals']['distance_m'], 8000)
        self.assertEqual(week['totals']['active_seconds'], 2500)
        self.assertEqual(week['totals']['hr_tss'], 50)
        self.assertEqual(week['load_share_percent'], 60)
        self.assertEqual(week['ranks']['distance_m'], 'highest')
        self.assertEqual(week['other'][0]['distance_m'], 1000)

    def test_different_tss_methods_and_missing_values_are_not_zero_or_combined(self):
        current = run('a', '2026-11-15')
        other = run('b', '2026-11-12')
        other['tss']['calculationMethod'] = 'POWER'
        other['tss']['trainingStressScore'] = 999
        other['distance_m'] = None
        summary = chart_summary(current, {}, [other])
        week = summary['week']
        self.assertEqual(week['totals']['hr_tss'], 20)
        self.assertEqual(week['totals']['hr_tss_count'], 1)
        self.assertIsNone(week['load_share_percent'])
        self.assertIsNone(week['ranks']['hr_tss'])
        self.assertIsNone(week['ranks']['distance_m'])
        self.assertIsNone(week['comparable'][0]['hr_tss'])

    def test_week_boundaries_use_workout_timezone_across_new_year(self):
        current = run('a', '2027-01-03')
        monday = run('b', '2026-12-27')
        monday['start_local'] = '2026-12-27T23:30:00+00:00'  # Monday in Warsaw.
        excluded = run('c', '2027-01-03')
        excluded['start_local'] = '2027-01-03T23:30:00+00:00'  # Next Monday in Warsaw.
        week = chart_summary(current, {}, [monday, excluded])['week']
        self.assertEqual((week['from'], week['to']), ('2026-12-28', '2027-01-03'))
        self.assertEqual(len(week['comparable']), 2)
        self.assertEqual(week['comparable'][0]['start_local'], '2026-12-28T00:30:00+01:00')

    def test_no_peer_does_not_claim_a_ranking_or_complete_week(self):
        week = chart_summary(run('a', '2026-11-15'), {})['week']
        self.assertIsNone(week['ranks']['distance_m'])
        self.assertIsNone(week['ranks']['hr_tss'])
        self.assertIn('may be incomplete', week['coverage'])

    def test_split_pattern_requires_repeated_alternation_and_complete_neighbours(self):
        analysis = {'laps': [{'index': i + 1, 'distance_m': 1000, 'pace_seconds_per_km': pace}
                             for i, pace in enumerate([360, 300, 350, 301, 355, 302, 360])]}
        result = split_pattern(analysis)
        self.assertEqual(result['count'], 3)
        self.assertEqual(result['fast_pace_range'], [300, 302])
        analysis['laps'][4]['distance_m'] = 200
        self.assertIsNone(split_pattern(analysis))
