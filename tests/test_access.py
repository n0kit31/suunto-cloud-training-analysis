import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import access


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.patch = patch.object(access, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.env = patch.dict(access.os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        (self.root / 'config.json').write_text(json.dumps({'client_id': 'test-app'}))
        self.credentials = {'client_id': 'test-app', 'client_secret': 'test-secret', 'subscription_key': 'test-key'}
        self.tokens = {'client_id': 'test-app', 'access_token': 'old-token', 'refresh_token': 'old-refresh',
                       'expires_in': 3600, 'received_at_unix': int(time.time()) - 7200}
        access.private_json(access.private_directory() / 'credentials.json', self.credentials)
        access.private_json(access.private_directory() / 'tokens.json', self.tokens)

    def response(self, payload):
        opener = MagicMock()
        opener.open.return_value = io.BytesIO(json.dumps(payload).encode())
        return opener

    def test_valid_token_needs_no_network_and_private_storage(self):
        self.tokens['received_at_unix'] = int(time.time())
        access.private_json(access.private_directory() / 'tokens.json', self.tokens)
        with patch.object(access, 'refresh_tokens') as refresh:
            self.assertEqual(access.get_access_token(), 'old-token')
        refresh.assert_not_called()
        self.assertEqual((access.private_directory() / 'tokens.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(access.private_directory().stat().st_mode & 0o777, 0o700)

    def test_expired_token_refresh_rotates_and_persists_before_returning(self):
        opener = self.response({'access_token': 'new-token', 'refresh_token': 'new-refresh', 'expires_in': 86400})
        with patch.object(access, 'build_opener', return_value=opener):
            self.assertEqual(access.get_access_token(), 'new-token')
        saved = access.load_tokens()
        self.assertEqual(saved['refresh_token'], 'new-refresh')
        self.assertTrue(access.is_current(saved))
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, access.TOKEN_URL)
        self.assertEqual(base64.b64decode(request.get_header('Authorization').split()[1]).decode(), 'test-app:test-secret')
        self.assertEqual(parse_qs(request.data.decode()), {'grant_type': ['refresh_token'], 'refresh_token': ['old-refresh']})

    def test_omitted_refresh_token_preserves_previous_one(self):
        with patch.object(access, 'build_opener', return_value=self.response({'access_token': 'new-token', 'expires_in': 86400})):
            access.get_access_token()
        self.assertEqual(access.load_tokens()['refresh_token'], 'old-refresh')

    def test_malformed_refresh_does_not_overwrite_existing_tokens(self):
        for response in [{'access_token': 'new-token'}, {'access_token': 'new-token', 'expires_in': 30, 'refresh_token': ''},
                         {'access_token': '', 'expires_in': 86400}]:
            with self.subTest(response=response):
                before = (access.private_directory() / 'tokens.json').read_bytes()
                with patch.object(access, 'build_opener', return_value=self.response(response)), self.assertRaises(access.AccessError):
                    access.get_access_token()
                self.assertEqual((access.private_directory() / 'tokens.json').read_bytes(), before)

    def test_invalid_grant_is_redacted_and_keeps_tokens(self):
        opener = MagicMock()
        opener.open.side_effect = HTTPError(access.TOKEN_URL, 400, 'Bad', {},
            io.BytesIO(b'{"error":"invalid_grant","error_description":"do-not-print-secret"}'))
        before = (access.private_directory() / 'tokens.json').read_bytes()
        with patch.object(access, 'build_opener', return_value=opener), self.assertRaises(access.AccessError) as error:
            access.get_access_token()
        self.assertIn('oauth.py', str(error.exception))
        self.assertNotIn('do-not-print-secret', str(error.exception))
        self.assertEqual((access.private_directory() / 'tokens.json').read_bytes(), before)

    def test_other_client_credentials_are_rejected(self):
        self.credentials['client_id'] = 'different-app'
        access.private_json(access.private_directory() / 'credentials.json', self.credentials)
        with self.assertRaises(access.AccessError):
            access.load_credentials()

    def test_401_gets_only_one_retry_and_new_token(self):
        operation = MagicMock(side_effect=[HTTPError('https://cloudapi.suunto.com', 401, 'Bad', {}, io.BytesIO(b'{}')), 'result'])
        with patch.object(access, 'get_access_token', side_effect=['old-token', 'new-token']) as tokens:
            self.assertEqual(access.authorized_call(operation), 'result')
        self.assertEqual(operation.call_args_list[0].args, ('old-token', 'test-key'))
        self.assertEqual(operation.call_args_list[1].args, ('new-token', 'test-key'))
        tokens.assert_called_with(force=True, rejected_token='old-token')

    def test_invalid_subscription_key_does_not_refresh_oauth(self):
        operation = MagicMock(side_effect=HTTPError('https://cloudapi.suunto.com', 401, 'Bad', {},
            io.BytesIO(b'{"message":"Invalid subscription key"}')))
        with patch.object(access, 'get_access_token', return_value='old-token') as tokens, self.assertRaises(access.AccessError):
            access.authorized_call(operation)
        self.assertEqual(tokens.call_count, 1)

    def test_second_reader_reuses_new_token_after_401(self):
        self.tokens.update({'access_token': 'already-refreshed', 'received_at_unix': int(time.time())})
        access.private_json(access.private_directory() / 'tokens.json', self.tokens)
        with patch.object(access, 'refresh_tokens') as refresh:
            self.assertEqual(access.get_access_token(force=True, rejected_token='old-token'), 'already-refreshed')
        refresh.assert_not_called()

    def test_network_error_never_echoes_signed_url_or_secret(self):
        message = access.safe_error(URLError('https://example.suunto.com/?secret=do-not-print'))
        self.assertNotIn('do-not-print', message)


if __name__ == '__main__':
    unittest.main()
