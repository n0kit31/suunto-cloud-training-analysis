import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs

from suunto_cloud.authentication import oauth
from suunto_cloud.storage import local


class OAuthTests(unittest.TestCase):
    def test_callback_defaults_to_loopback(self):
        with patch.dict(oauth.os.environ, {}, clear=True):
            self.assertEqual(oauth.callback_address(8765), ('127.0.0.1', 8765))

    def test_container_callback_can_listen_on_published_interface(self):
        with patch.dict(oauth.os.environ, {'SUUNTO_OAUTH_BIND_HOST': '0.0.0.0'}):
            self.assertEqual(oauth.callback_address(8765), ('0.0.0.0', 8765))

    def test_callback_rejects_unexpected_bind_host(self):
        with patch.dict(oauth.os.environ, {'SUUNTO_OAUTH_BIND_HOST': 'unexpected.example'}):
            with self.assertRaises(ValueError):
                oauth.callback_address(8765)

    def test_valid_callback_decodes_code(self):
        self.assertEqual(oauth.parse_callback("/callback?state=expected&code=a%2Bb", "expected", "/callback"), "a+b")

    def test_missing_wrong_and_duplicated_states_are_rejected(self):
        for query in ("code=x", "state=wrong&code=x", "state=%C5%82&code=x", "state=expected&state=wrong&code=x"):
            with self.subTest(query=query), self.assertRaises(ValueError):
                oauth.parse_callback("/callback?" + query, "expected", "/callback")

    def test_missing_and_duplicated_codes_are_rejected(self):
        for query in ("state=expected", "state=expected&code=", "state=expected&code=a&code=b"):
            with self.subTest(query=query), self.assertRaises(ValueError):
                oauth.parse_callback("/callback?" + query, "expected", "/callback")

    def test_unrelated_request_does_not_complete_authorization(self):
        with self.assertRaises(FileNotFoundError):
            oauth.parse_callback("/favicon.ico", "expected", "/callback")

    def test_denial_requires_valid_state(self):
        self.assertIsNone(oauth.parse_callback("/callback?state=expected&error=access_denied", "expected", "/callback"))
        with self.assertRaises(ValueError):
            oauth.parse_callback("/callback?error=access_denied", "expected", "/callback")

    def test_token_files_are_private_and_replaceable(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(local, "ROOT", Path(directory)):
            destination = oauth.save_tokens({"access_token": "test-only-token"})
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(destination.parent.stat().st_mode & 0o777, 0o700)
            oauth.save_tokens({"access_token": "replacement-test-token"})
            self.assertEqual(json.loads(destination.read_text())["access_token"], "replacement-test-token")
            self.assertEqual([p.name for p in destination.parent.iterdir()], ["tokens.json"])

    def test_exchange_authenticates_application_and_preserves_code_encoding(self):
        config = {"client_id": "developer-app", "redirect_uri": "http://127.0.0.1:8765/callback"}
        opener = MagicMock()
        opener.open.return_value = io.BytesIO(b'{"access_token":"test-only-token"}')
        with patch.object(oauth, "build_opener", return_value=opener):
            oauth.exchange_code(config, "application-secret", "a+b&c")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, oauth.TOKEN_URL)
        authorization = request.get_header("Authorization")
        self.assertEqual(base64.b64decode(authorization.split()[1]).decode(), "developer-app:application-secret")
        body = parse_qs(request.data.decode())
        self.assertEqual(body["code"], ["a+b&c"])
        self.assertEqual(body["redirect_uri"], [config["redirect_uri"]])
        self.assertNotIn("password", body)

    def test_token_401_reports_stage_without_echoing_server_description(self):
        body = b'{"error":"invalid_client","error_description":"test-secret-do-not-print"}'
        error = HTTPError(oauth.TOKEN_URL, 401, "Unauthorized", {}, io.BytesIO(body))
        opener = MagicMock()
        opener.open.side_effect = error
        with patch.object(oauth, "build_opener", return_value=opener):
            with self.assertRaises(oauth.TokenExchangeError) as result:
                oauth.exchange_code({"client_id": "app", "redirect_uri": "http://127.0.0.1:8765/callback"}, "secret", "code")
        message = str(result.exception)
        self.assertIn("HTTP 401", message)
        self.assertIn("invalid_client", message)
        self.assertIn("Client ID + Client secret", message)
        self.assertNotIn("test-secret-do-not-print", message)

    def test_invalid_grant_is_distinguished_from_application_credentials(self):
        error = HTTPError(oauth.TOKEN_URL, 400, "Bad Request", {}, io.BytesIO(b'{"error":"invalid_grant"}'))
        message = oauth.token_error_message(error)
        self.assertIn("new code", message)
        self.assertNotIn("Check the Client ID", message)


if __name__ == "__main__":
    unittest.main()
