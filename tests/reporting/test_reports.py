from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from suunto_cloud.reporting.reports import CHART_MARKER, cleanup_charts, moving_average, pace_from_speed, pace_series, thin, write_outputs
from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.analysis.fit import summarize
from tests.fixtures import fixture


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.data = fixture()
        self.analysis = summarize(self.data)
        self.cloud = cloud_metrics({'workoutKey': 'a' * 24, 'activityId': 1,
                                    'startTime': 1793894400000, 'stopTime': 1793894550000,
                                    'totalTime': 150, 'totalDistance': 420,
                                    'hrdata': {'workoutAvgHR': 145, 'workoutMaxHR': 160},
                                    'extensions': [{'type': 'SummaryExtension', 'pte': 2}]})
        self.entry = {'fit_path': 'example.fit', 'fit_sha256': 'checked'}

    def test_pace_uses_minutes_per_kilometre(self):
        self.assertAlmostEqual(pace_from_speed(4), 4 + 10 / 60)
        self.assertEqual(pace_from_speed(1000 / 300), 5)
        self.assertIsNone(pace_from_speed(0))
        series = pace_series([(float(i), {'speed': 1000 / 300}) for i in range(20)], 0)
        self.assertEqual([v for _, v in series], [5, 5])

    def test_hr_smoothing_softens_brief_spikes_and_preserves_sustained_changes(self):
        points = [(t, 180 if t == 10 else 150 if t >= 30 else 130) for t in range(61)]
        smoothed = dict(moving_average(points))
        self.assertLess(smoothed[10], 135)
        self.assertEqual(smoothed[50], 150)
        self.assertEqual(smoothed[0], 130)
        self.assertEqual(points[10], (10, 180))

    def test_hr_smoothing_does_not_mix_measurements_across_a_gap(self):
        points = [(t, 120) for t in range(10)] + [(t, 180) for t in range(12, 22)]
        smoothed = moving_average(points)
        self.assertEqual(smoothed, points)

    def test_hr_smoothing_resets_even_at_a_one_second_pause(self):
        at = lambda n: self.data['records'][n]['timestamp']
        for n, row in enumerate(self.data['records']):
            row['heart_rate'] = 120 if n < 5 else 180
        self.data['events'][1:1] = [
            {'event': 'timer', 'event_type': 'stop', 'timestamp': at(5)},
            {'event': 'timer', 'event_type': 'start', 'timestamp': at(6)},
        ]
        self.analysis = summarize(self.data)
        out = write_outputs(self.root, self.cloud, self.analysis, self.data, self.entry, 'now', charts=True)
        tree = ET.parse(out['chart_path'])
        hr_lines = [x for x in tree.iter() if x.attrib.get('clip-path') == 'url(#panel-0)']
        heights = {float(pair.split(',')[1]) for line in hr_lines for pair in line.attrib['points'].split()}
        self.assertEqual(heights, {130, 300})

    def test_default_produces_no_chart_and_preserves_written_assessment(self):
        with patch('suunto_cloud.reporting.reports.chart_svg', side_effect=AssertionError('Unexpected chart')):
            out = write_outputs(self.root, self.cloud, self.analysis, self.data, self.entry, 'first')
            self.assertIsNone(out['chart_path'])
            self.assertFalse((self.root / 'visualizations').exists())
            report = Path(out['markdown_path'])
            report.write_text(report.read_text() + '\n## Ocena\nWłasna analiza użytkownika.\n')
            write_outputs(self.root, self.cloud, self.analysis, self.data, self.entry, 'second')
        self.assertIn('Własna analiza użytkownika.', report.read_text())
        self.assertEqual(report.read_text().count('<!-- suunto-generated:start -->'), 1)

    def test_chart_requires_opt_in_and_has_a_real_pace_line(self):
        out = write_outputs(self.root, self.cloud, self.analysis, self.data, self.entry, 'now', charts=True)
        tree = ET.parse(out['chart_path'])
        lines = [x for x in tree.iter() if x.tag.endswith('polyline')]
        self.assertTrue(any(x.attrib.get('clip-path') == 'url(#panel-1)' for x in lines))
        self.assertIn(CHART_MARKER, Path(out['chart_path']).read_text())
        self.assertTrue(Path(out['json_path']).is_file())

    def test_reduction_retains_peaks_and_does_not_create_observations(self):
        points = [(i, 999 if i == 1234 else i % 10) for i in range(5000)]
        reduced = thin(points, 100)
        self.assertIn((1234, 999), reduced)
        self.assertEqual(reduced, sorted(reduced))
        self.assertTrue(set(reduced).issubset(points))

    def test_chart_removes_pause_time_and_connects_hr_gaps_only(self):
        at = lambda n: self.data['records'][n]['timestamp']
        self.data['events'][1:1] = [
            {'event': 'timer', 'event_type': 'stop', 'timestamp': at(60)},
            {'event': 'timer', 'event_type': 'start', 'timestamp': at(90)},
        ]
        for row in self.data['records'][20:25]:
            del row['heart_rate']
            del row['altitude']
        self.analysis = summarize(self.data)
        out = write_outputs(self.root, self.cloud, self.analysis, self.data, self.entry, 'now', charts=True)
        tree = ET.parse(out['chart_path'])
        hr_lines = [x for x in tree.iter() if x.attrib.get('clip-path') == 'url(#panel-0)']
        self.assertEqual(len(hr_lines), 1)
        altitude_lines = [x for x in tree.iter() if x.attrib.get('clip-path') == 'url(#panel-2)']
        self.assertEqual(len(altitude_lines), 2)
        points = [tuple(map(float, pair.split(',')))
                  for line in hr_lines for pair in line.attrib['points'].split()]
        self.assertEqual(len(points), 115)
        self.assertNotIn('heart_rate', self.data['records'][22])
        # At 90 elapsed seconds, only 60 active seconds have passed (out of 120).
        self.assertTrue(any(abs(x - (85 + 1075 * 60 / 120)) < .01 for x, _ in points))
        self.assertAlmostEqual(points[-1][0], 85 + 1075 * 119 / 120, places=2)
        self.assertFalse(any(x.attrib.get('fill') == '#dce1e6' for x in tree.iter()))
        self.assertIn('Czas aktywnego treningu (min)', Path(out['chart_path']).read_text())

    def test_cleanup_only_removes_old_owned_files_and_keeps_current_and_symlink(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=31)).timestamp()
        owned = self.root / 'suunto-old.svg'
        current = self.root / 'suunto-current.svg'
        user = self.root / 'suunto-user.svg'
        for path, text in [(owned, CHART_MARKER), (current, CHART_MARKER), (user, '<svg/>')]:
            path.write_text(text)
            os.utime(path, (old, old))
        link = self.root / 'suunto-link.svg'
        link.symlink_to(user)
        self.assertEqual(cleanup_charts(self.root, {str(current)}, now), [str(owned)])
        self.assertTrue(current.is_file())
        self.assertTrue(user.is_file())
        self.assertTrue(link.is_symlink())


if __name__ == '__main__':
    unittest.main()
