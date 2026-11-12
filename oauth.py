#!/usr/bin/env python3
"""Local Suunto OAuth callback and authorization-code exchange (standard library)."""

import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
AUTHORIZE_URL = "https://cloudapi-oauth.suunto.com/oauth/authorize"
TOKEN_URL = "https://cloudapi-oauth.suunto.com/oauth/token"


def parse_callback(path, expected_state, callback_path):
    url = urlsplit(path)
    if url.path != callback_path:
        raise FileNotFoundError("Nieznana ścieżka callback.")
    query = parse_qs(url.query, keep_blank_values=True)
    states = query.get("state", [])
    if len(states) != 1 or not secrets.compare_digest(states[0].encode(), expected_state.encode()):
        raise ValueError("Nieprawidłowy state. Użyj linku z bieżącego uruchomienia.")
    if "error" in query:
        return None
    codes = query.get("code", [])
    if len(codes) != 1 or not codes[0]:
        raise ValueError("Brak jednoznacznego kodu autoryzacji.")
    return codes[0]


def callback_handler(state, redirect_uri):
    redirect = urlsplit(redirect_uri)

    class CallbackHandler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def log_message(self, *args):
            pass  # Request URLs contain authorization codes.

        def do_GET(self):
            try:
                if self.headers.get("Host") != redirect.netloc:
                    raise ValueError("Nieprawidłowy adres callback.")
                code = parse_callback(self.path, state, redirect.path)
            except (FileNotFoundError, ValueError) as exc:
                status = 404 if isinstance(exc, FileNotFoundError) else 400
                message = str(exc)
            else:
                self.server.callback_received = True
                self.server.authorization_code = code
                status = 200
                message = (
                    "Odebrano kod Suunto. Wróć do terminala, aby sprawdzić wynik wymiany na token."
                    if code else "Autoryzacja nie została udzielona. Wróć do terminala."
                )
            body = message.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

    return CallbackHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TokenExchangeError(RuntimeError):
    pass


def token_error_message(exc):
    try:
        payload = json.loads(exc.read(8192))
        error = payload.get("error") if isinstance(payload, dict) else None
    except (ValueError, UnicodeError):
        error = None
    message = f"Wymiana kodu na token: HTTP {exc.code} z {TOKEN_URL}."
    if error in {"invalid_client", "invalid_grant", "invalid_request", "unauthorized_client", "unauthorized"}:
        message += f" Kod OAuth: {error}."
    if error == "invalid_grant":
        message += " Uruchom skrypt ponownie po nowy kod i sprawdź zgodność Redirect URI z panelem."
    elif exc.code == 401 or error in {"invalid_client", "unauthorized_client"}:
        message += (
            " Sprawdź parę Client ID + Client secret w OAuth application settings."
            " Client secret to sekret aplikacji, odrębny od hasła API Zone, hasła Suunto App"
            " oraz kluczy Primary/Secondary Developer API."
            " Konto API Zone może być inne niż konto połączone z zegarkiem."
        )
    else:
        message += " Sprawdź konfigurację OAuth i spróbuj ponownie z nowego linku."
    return message


def exchange_code(config, secret, code):
    credentials = base64.b64encode(
        f"{config['client_id']}:{secret}".encode("utf-8")
    ).decode("ascii")
    data = urlencode({
        "grant_type": "authorization_code",
        "redirect_uri": config["redirect_uri"],
        "code": code,
    }).encode("ascii")
    request = Request(TOKEN_URL, data=data, headers={
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }, method="POST")
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            tokens = json.load(response)
    except HTTPError as exc:
        raise TokenExchangeError(token_error_message(exc)) from None
    if (not isinstance(tokens, dict) or not isinstance(tokens.get("access_token"), str)
            or not tokens["access_token"]):
        raise ValueError("Suunto nie zwróciło access_token.")
    tokens["received_at_unix"] = int(time.time())
    tokens["client_id"] = config["client_id"]
    return tokens


def save_tokens(tokens, filename='tokens.json'):
    directory = ROOT / ".local"
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    destination = directory / filename
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as f:
            temporary = Path(f.name)
            json.dump(tokens, f, indent=2)
            f.write("\n")
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", action="store_true", help="Pokaż ustawienia, bez logowania")
    parser.add_argument("--prompt-secret", action="store_true", help="Wpisz sekret ręcznie, pomijając SUUNTO_CLIENT_SECRET")
    args = parser.parse_args()
    config = json.loads((ROOT / "config.json").read_text())
    if args.settings:
        print(json.dumps(config, indent=2))
        return
    redirect = urlsplit(config["redirect_uri"])
    if (redirect.scheme != "http" or redirect.hostname != "127.0.0.1"
            or not redirect.port or redirect.query or redirect.fragment
            or redirect.username or redirect.password or not redirect.path):
        raise ValueError("Callback musi mieć postać http://127.0.0.1:PORT/ścieżka.")
    state = secrets.token_urlsafe(32)
    with HTTPServer(("127.0.0.1", redirect.port), callback_handler(state, config["redirect_uri"])) as server:
        server.timeout = 1
        server.callback_received = False
        credentials_path = ROOT / '.local/credentials.json'
        saved = json.loads(credentials_path.read_text()) if credentials_path.is_file() else {}
        if not isinstance(saved, dict) or saved.get('client_id') != config['client_id']:
            saved = {}
        secret = None if args.prompt_secret else (os.environ.get("SUUNTO_CLIENT_SECRET") or saved.get('client_secret'))
        if secret:
            print("Client secret: używam zapisanej konfiguracji lub zmiennej środowiskowej.", flush=True)
        else:
            secret = getpass.getpass("Client secret aplikacji z OAuth application settings (nie hasło konta): ")
        if not secret:
            raise ValueError("Client secret jest wymagany.")
        url = AUTHORIZE_URL + "?" + urlencode({
            "response_type": "code",
            "client_id": config["client_id"],
            "redirect_uri": config["redirect_uri"],
            "state": state,
        })
        print(f"Client ID aplikacji: {config['client_id']}", flush=True)
        print("Otwórz poniższy link na tym komputerze i autoryzuj konto Suunto App:", flush=True)
        print("W przeglądarce użyj konta z aplikacji na telefonie, połączonego z zegarkiem.", flush=True)
        print(url, flush=True)
        print("Oczekiwanie na callback (10 minut)...", flush=True)
        deadline = time.monotonic() + 600
        while not server.callback_received and time.monotonic() < deadline:
            server.handle_request()
        if not server.callback_received:
            raise TimeoutError("Nie otrzymano callback w ciągu 10 minut.")
        if server.authorization_code is None:
            raise ValueError("Suunto zgłosiło odmowę lub błąd autoryzacji.")
        print("Odebrano poprawny callback. Wymiana kodu na token...", flush=True)
        tokens = exchange_code(config, secret, server.authorization_code)
        destination = save_tokens(tokens)
        save_tokens({**saved, 'client_id': config['client_id'], 'client_secret': secret}, 'credentials.json')
    print(f"Autoryzacja zakończona. Tokeny zapisano lokalnie: {destination}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nPrzerwano.", file=sys.stderr)
        sys.exit(130)
    except TokenExchangeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, URLError, EOFError) as exc:
        print(f"Błąd: {exc}", file=sys.stderr)
        sys.exit(1)
