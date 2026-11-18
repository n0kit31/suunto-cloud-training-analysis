import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from suunto_cloud.analysis.chart_summary import chart_summary
from suunto_cloud.analysis.fit import summarize
from suunto_cloud.reporting.command import main as charts
from suunto_cloud.reporting.reports import write_outputs
from suunto_cloud.reporting.summary import amount, summary_html
from suunto_cloud.storage.comparison import comparison_workouts
from tests.analysis.test_chart_summary import run
from tests.fixtures import fixture


class SummaryOutputTests(unittest.TestCase):
    def test_english_summary_shows_week_totals_and_highlights_current_session(self):
        self.assertEqual(amount(1.005, 2), '1.01')
        current = run('a', '2026-11-15', 5000, 1500, 30)
        earlier = run('b', '2026-11-10', activity=22)
        context = chart_summary(current, {}, [earlier])
        html = summary_html(context)
        self.assertIn('Workout summary', html)
        self.assertIn('This week', html)
        self.assertIn('8.00 km', html)
        self.assertIn('41:40', html)
        self.assertIn('60%', html)
        self.assertEqual(html.count('class="selected-workout"'), 1)
        self.assertIn('Trail running', html)

    def test_names_are_escaped_and_unavailable_load_is_explicit(self):
        current = run('a', '2026-11-15', activity=999)
        current['activity_name'] = '<img src=x onerror=alert(1)>'
        current['tss'] = None
        context = chart_summary(current, {})
        html = summary_html(context)
        self.assertNotIn('<img', html)
        self.assertIn('&lt;img', html)
        self.assertIn('0/1 sessions', html)
        self.assertIn('No other comparable session', html)

    def test_offline_regeneration_retains_week_context_without_cache_or_peer_files(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            data = fixture()
            decoded = project / 'samples.json'
            decoded.write_text(json.dumps(data))
            current = run('a', '2026-11-15', 5000, 1500, 30)
            earlier = run('b', '2026-11-10')
            entry = {'fit_path': 'synthetic.fit', 'fit_sha256': 'synthetic', 'decoded_path': str(decoded)}
            out = write_outputs(project, current, summarize(data), data, entry, 'synthetic',
                                charts=True, week_workouts=[earlier])
            with contextlib.redirect_stdout(io.StringIO()):
                charts([out['json_path']])
            saved = json.loads(Path(out['json_path']).read_text())
            self.assertEqual(saved['chart_summary']['week']['totals']['distance_m'], 8000)
            self.assertIn('8.00 km', Path(out['chart_path']).read_text())

    def test_saved_reports_are_used_when_optional_cloud_cache_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / 'reports').mkdir()
            earlier = run('b', '2026-11-10')
            (project / 'reports' / 'suunto-2026-11-10-090000.json').write_text(json.dumps({'cloud': earlier}))
            cached = project / 'suunto-cloud' / '.local' / 'workouts.json'
            cached.parent.mkdir(parents=True)
            cached.write_text('{"error": "not a valid workout list"}')
            peers = comparison_workouts(project, run('a', '2026-11-15'))
            self.assertEqual(peers, [earlier])

    def test_cloud_reports_with_workout_suffix_are_available_during_regeneration(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            samples = fixture()
            decoded = project / 'samples.json'
            decoded.write_text(json.dumps(samples))
            current = run('a', '2026-11-15', 5000)
            earlier = run('b', '2026-11-10', 3000)
            local = run('c', '2026-11-10', 9000)
            source = {'fit_path': 'synthetic.fit', 'fit_sha256': 'synthetic', 'decoded_path': str(decoded)}
            analysis = summarize(samples)
            earlier_out = write_outputs(project, earlier, analysis, samples, source, 'synthetic')
            self.assertIn('-cloud-', Path(earlier_out['json_path']).name)
            write_outputs(project, local, analysis, samples, {**source, 'source_type': 'local_fit'}, 'synthetic')
            out = write_outputs(project, current, analysis, samples, source, 'synthetic')
            with contextlib.redirect_stdout(io.StringIO()):
                charts([out['json_path']])
            saved = json.loads(Path(out['json_path']).read_text())
            self.assertEqual(saved['chart_summary']['week']['totals']['distance_m'], 8000)

    def test_regeneration_updates_legacy_report_in_place_and_new_sync_preserves_its_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            samples = fixture()
            decoded = project / 'samples.json'
            decoded.write_text(json.dumps(samples))
            current = run('a', '2026-11-15', 5000)
            source = {'fit_path': 'synthetic.fit', 'fit_sha256': 'synthetic', 'decoded_path': str(decoded)}
            analysis = summarize(samples)
            reports = project / 'reports'
            reports.mkdir()
            legacy = reports / 'suunto-2026-11-15-090000.json'
            legacy.write_text(json.dumps({'retrieved_at_utc': 'synthetic', 'cloud': current,
                                          'fit': analysis, 'source': source}))
            markdown = legacy.with_suffix('.md')
            markdown.write_text('# Workout\n\nSynthetic assessment.\n')
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                charts([str(legacy)])
            regenerated = json.loads(stdout.getvalue())
            self.assertEqual(regenerated['json_path'], str(legacy.resolve()))
            self.assertIn('Synthetic assessment.', markdown.read_text())
            self.assertTrue(Path(regenerated['chart_path']).is_file())

            fresh = write_outputs(project, current, analysis, samples, source, 'fresh')
            self.assertNotEqual(fresh['json_path'], str(legacy))
            self.assertIn('Synthetic assessment.', Path(fresh['markdown_path']).read_text())
            self.assertEqual(json.loads(legacy.read_text())['retrieved_at_utc'], 'synthetic')
            other = write_outputs(project, {**current, 'workout_key': 'b'}, analysis, samples, source, 'fresh')
            self.assertNotIn('Synthetic assessment.', Path(other['markdown_path']).read_text())
