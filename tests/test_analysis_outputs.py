from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis_outputs import CHART_MARKER, cleanup_charts, pace_from_speed, pace_series, thin, write_outputs
from analysis_packet import cloud_metrics
from analyze_fit import summarize
from test_analysis_details import fixture


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

    def test_default_produces_no_chart_and_preserves_written_assessment(self):
        with patch('analysis_outputs.chart_svg', side_effect=AssertionError('Unexpected chart')):
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
