import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from zoneinfo import ZoneInfo

from suunto_cloud import web_bridge
from suunto_cloud.authentication import oauth, web_settings
from suunto_cloud.downloads import workouts
from suunto_cloud.reporting.chart_model import prepare_chart
from suunto_cloud.storage import local
from tests.fixtures import fixture, workout


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 25, 23, 30, tzinfo=timezone.utc).astimezone(tz)


class WebBridgeTests(unittest.TestCase):
    def test_auth_revision_changes_on_settings_or_sign_in_and_survives_refresh(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(local, 'ROOT', Path(directory)):
            settings = {'clientId': 'test-client', 'clientSecret': 'test-secret', 'subscriptionKey': 'initial-key'}
            web_settings.save_settings(settings)
            config = local.read_config()
            self.assertIsNone(web_bridge.authorization_revision())
            oauth.complete_authorization(config, 'test-secret', 'test-secret', {
                'client_id': 'test-client', 'access_token': 'initial-token', 'refresh_token': 'test-refresh',
            })
            first = web_bridge.authorization_revision()
            self.assertTrue(first)
            token_path = local.authentication_directory() / 'tokens.json'
            tokens = json.loads(token_path.read_text())
            oauth.save_tokens({**tokens, 'access_token': 'refreshed-token'})
            self.assertEqual(web_bridge.authorization_revision(), first)
            web_settings.save_settings({**settings, 'subscriptionKey': 'updated-key'})
            updated = web_bridge.authorization_revision()
            self.assertNotEqual(updated, first)
            oauth.complete_authorization(config, 'test-secret', 'test-secret', tokens)
            self.assertNotEqual(web_bridge.authorization_revision(), updated)

    def test_vendor_product_fallback_never_uses_sensor_or_unknown_id(self):
        creator = {'type': 'activity', 'manufacturer': 'suunto', 'product': 67}
        sensor = {'device_index': 1, 'manufacturer': 'suunto', 'product_name': 'Synthetic sensor'}
        self.assertEqual(web_bridge.recording_device_model({'file_ids': [creator]}), 'Suunto Vertical 2')
        self.assertIsNone(web_bridge.recording_device_model({'file_ids': [{**creator, 'product': 65534}],
                                                             'device_infos': [sensor]}))
        self.assertIsNone(web_bridge.recording_device_model({'file_ids': [{**creator, 'manufacturer': 1}]}))

    def test_nordic_walking_summary_and_chart_both_use_step_cadence(self):
        decoded = fixture()
        decoded['sessions'][0].update(sport='generic', avg_cadence=100)
        for record in decoded['records']:
            record['cadence'] = 100
        cloud = web_bridge.cloud_metrics(workout('1' * 24, '2026-11-11'), timezone.utc)
        cloud['activity_id'] = 24
        analysis = web_bridge.summarize(decoded, timezone.utc)
        metrics = web_bridge.workout_metrics(cloud, analysis, web_bridge.chart_summary(cloud, analysis),
                                             web_bridge.summary_fields(cloud, decoded))
        chart = prepare_chart(decoded, analysis, cloud)
        cadence = next(panel for panel in chart.panels if panel.key == 'cadence')
        self.assertEqual((metrics['avgCadence'], metrics['cadenceUnit']), (200, 'spm'))
        self.assertEqual(cadence.unit, 'steps/min')
        self.assertTrue(all(value == 200 for group in cadence.groups for _, value in group))

    def test_initial_scope_uses_local_calendar_days_and_incremental_scope_uses_modifications(self):
        zone = ZoneInfo('Europe/Warsaw')
        late = {**workout('1' * 24, '2026-10-22'), 'lastModified': 1795648000000}
        recent = {**workout('2' * 24, '2026-10-28'), 'lastModified': 1795600000000}
        old = {**workout('3' * 24, '2026-10-27'), 'lastModified': 1790000000000}
        records = [late, recent, old]
        calls = []

        def fetch(_token, _key, until=None, limit=2):
            calls.append(until)
            return [record for record in records if until is None or record['lastModified'] < until][:limit]

        with (patch.object(web_bridge, 'user_timezone', return_value=zone),
              patch.object(web_bridge, 'datetime', FrozenDateTime),
              patch.object(workouts, 'PAGE_SIZE', 2),
              patch.object(web_bridge, 'fetch_workouts', side_effect=fetch),
              patch.object(web_bridge, 'authorized_call', side_effect=lambda fn: fn('synthetic', 'synthetic')),
              patch.dict('os.environ', {'SUUNTO_REQUEST_INTERVAL_MS': '0'})):
            initial = web_bridge.list_workouts(30, None)
            incremental = web_bridge.list_workouts(None, recent['lastModified'])

        self.assertEqual(calls, [None, recent['lastModified'] + 1] * 2)
        self.assertEqual(initial['timeZone'], 'Europe/Warsaw')
        self.assertEqual([row['sourceKey'] for row in initial['workouts']], [recent['workoutKey']])
        self.assertEqual([row['sourceKey'] for row in incremental['workouts']],
                         [late['workoutKey'], recent['workoutKey']])
        self.assertEqual(initial['highWatermark'], late['lastModified'])

    def test_local_fit_publishes_calculated_metrics_and_interactive_chart_without_cloud(self):
        content = b'\x00' * 8 + b'.FIT synthetic fixture'
        decoded = fixture()
        decoded['file_ids'] = [{'type': 'activity', 'product_name': 'Suunto Vertical 2'}]
        decoded['device_infos'] = [{'device_index': 1, 'product_name': 'Synthetic chest strap'}]
        decoded['sessions'][0].update(total_distance=420, total_timer_time=150, avg_heart_rate=143,
                                      max_heart_rate=160, total_ascent=8, avg_cadence=90, avg_power=210)
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            source = project / 'upload.fit'
            source.write_bytes(content)
            workspace = project / 'job'
            with (patch.object(web_bridge, 'decode_fit', return_value=decoded) as decode,
                  patch.object(web_bridge, 'user_timezone', return_value=timezone.utc),
                  patch.object(web_bridge, 'authorized_call',
                               side_effect=AssertionError('A local upload must work offline.')),
                  contextlib.redirect_stdout(io.StringIO()) as stdout):
                self.assertEqual(web_bridge.run(['analyze', '--workspace', str(workspace), '--fit', str(source)]), 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(decode.call_args.args[0], workspace / 'source.fit')
            self.assertEqual((workspace / 'source.fit').read_bytes(), content)
            self.assertEqual((workspace / 'source.fit').stat().st_mode & 0o777, 0o600)
            self.assertEqual(result['fitSha256'], hashlib.sha256(content).hexdigest())
            self.assertEqual(result['summary']['sport'], 'Running')
            self.assertEqual(result['deviceModel'], 'Suunto Vertical 2')
            self.assertEqual(result['summary']['activeSeconds'], 150)
            self.assertEqual(result['metrics']['avgCadence'], 180)
            self.assertEqual(result['metrics']['cadenceUnit'], 'spm')
            self.assertEqual(result['metrics']['avgPowerW'], 210)
            self.assertEqual(result['laps'][0]['distanceM'], 240)
            self.assertTrue(result['observations'])
            self.assertTrue(result['chart'])
            self.assertIn('<script', (workspace / 'chart.html').read_text())
            self.assertEqual(sorted(path.name for path in workspace.iterdir()), ['chart.html', 'source.fit'])

    def test_rate_limit_response_preserves_retry_delay_and_hides_upstream_details(self):
        error = HTTPError('https://example.invalid/private-download', 429, 'rate limited',
                          {'Retry-After': '120'}, io.BytesIO(b'private response'))
        with (patch.object(web_bridge, 'list_workouts', side_effect=error),
              contextlib.redirect_stdout(io.StringIO()) as stdout):
            self.assertEqual(web_bridge.run(['list', '--since-days', '30']), 1)
        response = json.loads(stdout.getvalue())
        self.assertEqual(response, {'error': {'code': 'RATE_LIMIT',
                                             'message': 'Suunto rate limit reached. Try again later.',
                                             'retryAfterMs': 120000}})
