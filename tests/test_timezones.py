from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.storage import local
from suunto_cloud.timezones import TimeZoneError, local_timestamp
from tests.fixtures import fixture, workout


class TimeZoneTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = Path(directory.name) / 'config.json'
        location = patch.object(local, 'config_path', return_value=self.config)
        location.start()
        self.addCleanup(location.stop)

    def test_explicit_override_then_configuration_then_tz(self):
        self.config.write_text(json.dumps({'timezone': 'Asia/Tokyo'}))
        with patch.dict(os.environ, {'SUUNTO_TIMEZONE': '', 'TZ': 'Pacific/Honolulu'}):
            self.assertEqual(local.user_timezone().key, 'Asia/Tokyo')
            with patch.dict(os.environ, {'SUUNTO_TIMEZONE': 'Europe/London'}):
                self.assertEqual(local.user_timezone().key, 'Europe/London')
        self.config.unlink()
        with patch.dict(os.environ, {'SUUNTO_TIMEZONE': '', 'TZ': 'Asia/Kolkata'}):
            self.assertEqual(local.user_timezone().key, 'Asia/Kolkata')

    def test_unset_or_null_timezone_uses_the_system(self):
        with patch.dict(os.environ, {'SUUNTO_TIMEZONE': '', 'TZ': ''}):
            self.assertIsNone(local.user_timezone())
            self.config.write_text(json.dumps({'timezone': None}))
            self.assertIsNone(local.user_timezone())

    def test_invalid_names_and_setting_types_are_rejected(self):
        with patch.dict(os.environ, {'SUUNTO_TIMEZONE': '', 'TZ': ''}):
            for value in ('Invalid/TimeZone', 123, True, []):
                with self.subTest(value=value):
                    self.config.write_text(json.dumps({'timezone': value}))
                    with self.assertRaises(TimeZoneError):
                        local.user_timezone()

    def test_explicit_zone_handles_both_occurrences_of_a_dst_hour(self):
        zone = ZoneInfo('America/New_York')
        first = local_timestamp(datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc).timestamp(), zone)
        second = local_timestamp(datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc).timestamp(), zone)
        self.assertEqual((first.hour, first.minute, first.fold), (1, 30, 0))
        self.assertEqual((second.hour, second.minute, second.fold), (1, 30, 1))
        self.assertEqual(first.utcoffset(), timedelta(hours=-4))
        self.assertEqual(second.utcoffset(), timedelta(hours=-5))

    @unittest.skipUnless(hasattr(time, 'tzset'), 'System time zone changes require tzset')
    def test_system_fallback_uses_historical_dst_rules(self):
        try:
            with patch.dict(os.environ, {'TZ': 'America/New_York'}):
                time.tzset()
                winter = datetime(2026, 1, 15, 12, tzinfo=timezone.utc).timestamp()
                summer = datetime(2026, 7, 15, 12, tzinfo=timezone.utc).timestamp()
                self.assertEqual(local_timestamp(winter).utcoffset(), timedelta(hours=-5))
                self.assertEqual(local_timestamp(summer).utcoffset(), timedelta(hours=-4))
        finally:
            time.tzset()

    def test_cloud_and_fit_use_the_same_zone_across_midnight(self):
        zone = ZoneInfo('Asia/Tokyo')
        source = workout(day='2026-11-05')
        source['startTime'] = int(datetime(2026, 11, 5, 16, tzinfo=timezone.utc).timestamp() * 1000)
        source['stopTime'] = source['startTime'] + 150000
        cloud = cloud_metrics(source, zone)
        fit = summarize(fixture(), zone)
        self.assertEqual(cloud['start_local'], '2026-11-06T01:00:00+09:00')
        self.assertEqual(fit['laps'][0]['start_local'], cloud['start_local'])
        self.assertEqual((cloud['timezone'], fit['timezone']), ('Asia/Tokyo', 'Asia/Tokyo'))
