import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.analysis.sleep import recovery_context
from suunto_cloud.reporting.command import main as charts
from suunto_cloud.reporting.reports import write_outputs
from tests.analysis.test_sleep import night, snapshot
from tests.fixtures import fixture


class RecoveryOutputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.data = fixture()
        self.analysis = summarize(self.data)
        self.cloud = cloud_metrics({'workoutKey': 'a' * 24, 'totalDistance': 420,
                                    'totalTime': 150, 'startTime': 1793894400000,
                                    'stopTime': 1793894550000})
        self.cloud.update(start_local='2026-01-15T18:00:00+01:00',
                          stop_local='2026-01-15T19:00:00+01:00', timezone='Europe/Warsaw')
        self.decoded = self.root / 'synthetic.json'
        self.decoded.write_text(json.dumps(self.data))
        self.entry = {'fit_path': 'synthetic.fit', 'fit_sha256': 'synthetic', 'decoded_path': str(self.decoded)}
        self.context = recovery_context(self.cloud, snapshot([night(), night('2026-01-16', hrv=40)]))

    def outputs(self, **options):
        return write_outputs(self.root, self.cloud, self.analysis, self.data, self.entry, 'synthetic', **options)

    def test_card_expands_canvas_and_keeps_every_panel_below_it(self):
        out = self.outputs(charts=True, recovery=self.context)
        tree = ET.parse(out['chart_path'])
        sections = [x for x in tree.iter() if x.attrib.get('data-section') == 'pre-workout-recovery']
        self.assertEqual(len(sections), 1)
        self.assertIn('Recovery panels: local wake date', Path(out['chart_path']).read_text())
        self.assertIn('50 ms', ' '.join(x.text or '' for x in sections[0].iter()))
        self.assertNotIn('40 ms', ' '.join(x.text or '' for x in sections[0].iter()))
        panels = [x for x in tree.iter() if 'data-metric' in x.attrib]
        for panel in panels:
            clip = next(x for x in panel.iter() if x.tag.endswith('rect'))
            self.assertGreater(float(clip.attrib['y']), 932)
        text = Path(out['markdown_path']).read_text()
        self.assertIn('## Night after workout', text)
        self.assertIn('-10 ms', text)
        saved = json.loads(Path(out['json_path']).read_text())
        self.assertEqual(saved['recovery'], self.context)

    def test_chart_regeneration_retains_saved_recovery_without_an_import(self):
        out = self.outputs(recovery=self.context)
        with contextlib.redirect_stdout(io.StringIO()):
            charts([out['json_path']])
        saved = json.loads(Path(out['json_path']).read_text())
        self.assertEqual(saved['recovery'], self.context)
        self.assertIn('Pre-workout recovery', Path(saved['chart_path']).read_text())

    def test_explicit_sleep_import_updates_chart_and_preserves_existing_assessment(self):
        out = self.outputs()
        report = Path(out['markdown_path'])
        report.write_text(report.read_text() + '\nPersonal assessment to preserve.\n')
        source = self.root / 'sleep.json'
        source.write_text(json.dumps(snapshot([night(hrv=65)])))
        with contextlib.redirect_stdout(io.StringIO()):
            charts([out['json_path'], '--sleep-data', str(source)])
        saved = json.loads(Path(out['json_path']).read_text())
        self.assertEqual(saved['recovery']['before']['hrv_ms'], 65)
        self.assertIn('65 ms', Path(saved['chart_path']).read_text())
        self.assertIn('Personal assessment to preserve.', report.read_text())

    def test_missing_sleep_has_no_fake_values_or_readiness_status(self):
        context = recovery_context(self.cloud, snapshot([]))
        out = self.outputs(charts=True, recovery=context)
        svg = Path(out['chart_path']).read_text()
        self.assertIn('No completed sleep', svg)
        self.assertNotIn('0 ms', svg)
        ET.fromstring(svg)

    def test_history_preserves_missing_nights_and_separates_post_workout_values(self):
        rows = [night(f'2026-01-{day:02d}', DeepSleepDuration=6000,
                      LightSleepDuration=18000, REMSleepDuration=4800)
                for day in (9, 10, 12, 13, 14, 15, 16)]
        rows[-1]['entryData']['AvgHRV'] = 40
        context = recovery_context(self.cloud, snapshot(rows))
        out = self.outputs(charts=True, recovery=context)
        tree = ET.parse(out['chart_path'])
        sections = {x.attrib['data-section']: x for x in tree.iter() if 'data-section' in x.attrib}
        hrv = sections['hrv-history']
        lines = [x for x in hrv if x.attrib.get('data-role') == 'hrv-daily-line']
        self.assertEqual(len(lines), 4)  # 9–10 and 12–13–14–15; no bridge through the 11th.
        after = [x for x in hrv if x.attrib.get('data-role') == 'after-workout']
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0].attrib['fill'], 'white')
        self.assertEqual(after[0].attrib['data-value'], '40')
        selected = next(x for x in hrv if x.attrib.get('data-role') == 'selected-night')
        self.assertEqual(selected.attrib['stroke'], '#17212b')
        self.assertEqual(context['hrv_7d']['average_ms'], 50)
        bars = [x for x in sections['sleep-history'] if 'data-stage' in x.attrib]
        self.assertEqual(len(bars), 21)
        self.assertFalse(any(x.attrib['data-wake-date'] == '2026-01-11' for x in bars))

    def test_unavailable_stage_breakdown_uses_total_sleep_without_invented_stages(self):
        out = self.outputs(charts=True, recovery=self.context)
        tree = ET.parse(out['chart_path'])
        bars = [x for x in tree.iter() if 'data-stage' in x.attrib]
        self.assertEqual(len(bars), 2)
        self.assertTrue(all(x.attrib['data-stage'] == 'unknown' for x in bars))
        self.assertTrue(all(float(x.attrib['height']) > 0 for x in bars))

    def test_tile_colors_have_visible_labels_and_the_reference_remains_neutral(self):
        rows = [night(f'2026-01-{day:02d}', hrv=40 + (day % 5) * 5) for day in range(1, 15)]
        context = recovery_context(self.cloud, snapshot(rows + [night(hrv=64)]))
        out = self.outputs(charts=True, recovery=context)
        tree = ET.parse(out['chart_path'])
        tiles = {x.attrib['data-tile']: x for x in tree.iter() if 'data-tile' in x.attrib}
        self.assertEqual(tiles['0'].attrib['data-status'], 'yellow')
        self.assertEqual(tiles['1'].attrib['data-status'], 'green')
        self.assertEqual(tiles['2'].attrib['data-status'], 'reference')
        self.assertIn('Outside reference', ' '.join(x.text or '' for x in tiles['0']))
        self.assertIn('Within reference', ' '.join(x.text or '' for x in tiles['1']))
