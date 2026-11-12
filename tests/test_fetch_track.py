import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('fetch_track', ROOT / 'fetch_track.py')
track = importlib.util.module_from_spec(spec)
spec.loader.exec_module(track)


class FetchTrackTests(unittest.TestCase):
    def workout(self, key='a' * 24):
        return {'workoutKey': key, 'startTime': 1793725904320, 'extensionTypes': ['LOCATIONSTREAM']}

    def test_date_selection_rejects_ambiguity(self):
        workout = self.workout()
        self.assertEqual(track.choose_workout([workout], '2026-11-03'), workout)
        with self.assertRaises(ValueError):
            track.choose_workout([workout, self.workout('b' * 24)], '2026-11-03')

    def test_no_track_is_not_replaced_with_planned_route(self):
        workout = self.workout()
        workout['extensionTypes'] = ['SUMMARY']
        with self.assertRaises(ValueError):
            track.choose_workout([workout])

    def test_non_fit_response_is_rejected(self):
        opener = MagicMock()
        opener.open.return_value = io.BytesIO(b'<html>login</html>')
        with patch.object(track, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'binarnego pliku FIT'):
                track.fetch_fit('a' * 24, 'test-token', 'test-key')

    def test_redirect_does_not_receive_credentials(self):
        opener = MagicMock()
        fit_header = b'\x0e' + b'\x00' * 7 + b'.FIT' + b'\x00\x00'
        redirect = HTTPError('https://cloudapi.suunto.com', 302, 'Found',
                             {'Location': 'https://example.blob.core.windows.net/test.fit'}, io.BytesIO())
        opener.open.side_effect = [redirect, io.BytesIO(fit_header)]
        with patch.object(track, 'build_opener', return_value=opener):
            self.assertEqual(track.fetch_fit('a' * 24, 'test-token', 'test-key'), fit_header)
        first = opener.open.call_args_list[0].args[0]
        second = opener.open.call_args_list[1].args[0]
        self.assertEqual(first.get_header('Authorization'), 'Bearer test-token')
        self.assertIsNone(second.get_header('Authorization'))
        self.assertIsNone(second.get_header('Ocp-apim-subscription-key'))


if __name__ == '__main__':
    unittest.main()
