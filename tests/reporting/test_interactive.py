import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.reporting.reports import chart_svg, write_outputs
from tests.fixtures import fixture


class ChartDataParser(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.collecting = False
        self.payload = ''
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('id') == 'chart-data':
            self.collecting = True

    def handle_endtag(self, tag):
        if tag == 'script':
            self.collecting = False

    def handle_data(self, value):
        if self.collecting:
            self.payload += value


class InteractiveOutputTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.data = fixture()
        self.cloud = cloud_metrics({'workoutKey': 'a' * 24, 'activityId': 1,
                                    'startTime': 1793894400000, 'stopTime': 1793894550000,
                                    'totalTime': 150, 'totalDistance': 420})

    def output(self):
        return write_outputs(self.root, self.cloud, summarize(self.data), self.data,
                             {'fit_path': 'synthetic.fit', 'fit_sha256': 'synthetic'}, 'synthetic', charts=True)

    def test_html_is_default_and_svg_export_and_report_links_are_preserved(self):
        out = self.output()
        html = Path(out['chart_path']).read_text()
        self.assertEqual(Path(out['chart_path']).suffix, '.html')
        self.assertTrue(Path(out['svg_path']).is_file())
        self.assertIn(out['chart_path'], Path(out['markdown_path']).read_text())
        saved = json.loads(Path(out['json_path']).read_text())
        self.assertEqual(saved['chart_path'], out['chart_path'])
        self.assertEqual(saved['svg_path'], out['svg_path'])
        self.assertIn(Path(out['svg_path']).read_text(), html)
        self.assertNotIn('<script src=', html)
        self.assertNotIn('<link rel="stylesheet"', html)
        payload = json.loads(ChartDataParser(html).payload)
        self.assertEqual(payload['total_seconds'], 150)
        self.assertEqual(payload['panels'][0]['key'], 'heart-rate')
        self.assertEqual([(lap['start'], lap['end']) for lap in payload['laps']], [(0, 60), (60, 150)])
        self.assertNotIn('position_lat', payload)

    def test_hover_observations_exclude_pauses_and_keep_measurement_gaps(self):
        at = lambda n: self.data['records'][n]['timestamp']
        self.data['events'][1:1] = [
            {'event': 'timer', 'event_type': 'stop', 'timestamp': at(60)},
            {'event': 'timer', 'event_type': 'start', 'timestamp': at(90)},
        ]
        for row in self.data['records'][60:90]:
            row['heart_rate'] = 999
        for row in self.data['records'][20:25]:
            del row['heart_rate']
        out = self.output()
        payload = json.loads(ChartDataParser(Path(out['chart_path']).read_text()).payload)
        hr = next(p for p in payload['panels'] if p['key'] == 'heart-rate')
        self.assertEqual(payload['total_seconds'], 120)
        self.assertFalse(any(20 <= t < 25 for t, _ in hr['points']))
        self.assertTrue(all(value < 999 for _, value in hr['points']))
        self.assertTrue(all(value < 999 for _, value in payload['observed_hr']))
        self.assertEqual(hr['points'][-1][0], 119)
        self.assertEqual(payload['distance'][-1][0], 119)

    def test_untrusted_labels_cannot_end_the_embedded_json_script(self):
        self.cloud.update(activity_id=999, activity_name='Run </script><script>alert(1)</script> & snow \u2028')
        out = self.output()
        html = Path(out['chart_path']).read_text()
        payload = ChartDataParser(html).payload
        self.assertIn('Run </script><script>alert(1)</script>', json.loads(payload)['title'])
        self.assertNotIn('</script>', payload)
        self.assertNotIn('<script>alert(1)</script>', html)

    def test_every_workout_axis_uses_fixed_ten_minute_ticks(self):
        self.data['events'][-1]['timestamp'] = '2026-11-05T16:51:40Z'
        svg = chart_svg(self.data, summarize(self.data), self.cloud)
        tree = ET.fromstring(svg)
        panels = [node for node in tree.iter() if 'data-metric' in node.attrib]
        self.assertGreater(len(panels), 1)
        for panel in panels:
            ticks = [int(node.attrib['data-active-tick']) for node in panel if 'data-active-tick' in node.attrib]
            self.assertEqual(ticks, [0, 600, 1200, 1800, 2400, 3000])

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for chart interaction tests')
    def test_cursor_interactions_in_javascript_runtime(self):
        harness = Path(__file__).with_name('interactive_harness.cjs')
        result = subprocess.run(['node', str(harness)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
