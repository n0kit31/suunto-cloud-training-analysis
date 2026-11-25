"""Exercise Compose against a generated FIT file without cloud credentials."""

import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


def fit_crc(data):
    checksum = 0
    for byte in data:
        checksum ^= byte
        for _ in range(8):
            checksum = (checksum >> 1) ^ (0xA001 if checksum & 1 else 0)
    return struct.pack('<H', checksum)


def fit_activity(start=1_000_000_000, device_model=None, gps=False):
    def definition(local, message, *fields):
        return struct.pack('<BBBHB', 0x40 | local, 0, 0, message, len(fields)) + bytes(
            byte for field in fields for byte in field)

    timestamp = (253, 4, 0x86)
    if device_model:
        model = device_model.encode() + b'\0'
        data = definition(0, 0, (0, 1, 0), (1, 2, 0x84), (2, 2, 0x84), (4, 4, 0x86), (8, len(model), 7))
        data += struct.pack('<BBHHI', 0, 4, 23, 1, start) + model
    else:
        data = definition(0, 0, (0, 1, 0), (4, 4, 0x86))
        data += struct.pack('<BBI', 0, 4, start)
    data += definition(1, 21, timestamp, (0, 1, 0), (1, 1, 0))
    data += struct.pack('<BIBB', 1, start, 0, 0)
    coordinates = ((0, 4, 0x85), (1, 4, 0x85)) if gps else ()
    data += definition(2, 20, timestamp, (3, 1, 2), (5, 4, 0x86), (6, 2, 0x84), *coordinates)
    for second in range(61):
        data += struct.pack('<BIBIH', 2, start + second, 130 + second % 10, second * 300, 3000)
        if gps:
            data += struct.pack('<ii', second * 10, second * 100)
    data += struct.pack('<BIBB', 1, start + 60, 0, 4)
    data += definition(3, 18, timestamp, (2, 4, 0x86), (5, 1, 0), (7, 4, 0x86),
                       (8, 4, 0x86), (9, 4, 0x86), (16, 1, 2), (17, 1, 2))
    data += struct.pack('<BIIBIIIBB', 3, start + 60, start, 1, 60_000, 60_000, 18_000, 134, 139)

    header = struct.pack('<BBHI4s', 14, 0x10, 100, len(data), b'.FIT')
    return header + fit_crc(header) + data + fit_crc(data)


def request(base, path, *, body=None, headers=None, expected=200, method=None):
    req = Request(base + path, data=body, headers=headers or {}, method=method)
    try:
        response = urlopen(req, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        assert response.status == expected, f'{path}: expected {expected}, got {response.status}'
        content = response.read()
        if response.headers.get_content_type() == 'application/json':
            content = json.loads(content)
        return content, response.headers


def eventually(callback, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = callback()
            if result:
                return result
        except (URLError, ConnectionError):
            pass
        time.sleep(0.4)
    raise AssertionError('Timed out waiting for the web application.')


def upload(base, content):
    boundary = 'synthetic-fit-smoke-boundary'
    body = (
        f'--{boundary}\r\n'
        'Content-Disposition: form-data; name="files"; filename="synthetic.fit"\r\n'
        'Content-Type: application/octet-stream\r\n\r\n'
    ).encode() + content + f'\r\n--{boundary}--\r\n'.encode()
    return request(base, '/api/import', body=body, expected=202, headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'X-Suunto-Request': '1',
        'Origin': base,
    })[0]


def ready_workout(base, total):
    library, _ = request(base, '/api/workouts?limit=2')
    if library['total'] == total and all(entry['status'] == 'ready' for entry in library['workouts']):
        return library['workouts'][0]
    failed = next((entry for entry in library['workouts'] if entry['status'] == 'failed'), None)
    assert failed is None, f'Synthetic FIT failed: {failed}'
    return None


def main(override_path):
    repo = Path(__file__).resolve().parents[2]
    project = f'suunto-web-test-{uuid4().hex[:8]}'
    environment = {**os.environ, 'SUUNTO_UID': str(os.getuid()), 'SUUNTO_GID': str(os.getgid()),
                   'SUUNTO_WEB_PORT': '0', 'SUUNTO_TIMEZONE': 'Europe/Warsaw'}
    environment['SUUNTO_WEB_AUTH_DIR'] = '/synthetic-auth-bind-must-not-be-mounted'
    environment.pop('COMPOSE_ENV_FILES', None)

    volumes = [
        {'type': 'volume', 'source': 'smoke-config', 'target': '/auth-config', 'read_only': True},
        {'type': 'volume', 'source': 'smoke-auth', 'target': '/auth/.local'},
    ]
    override_path.write_text(json.dumps({
        'volumes': {'smoke-config': {}, 'smoke-auth': {}},
        'services': {
            'worker': {'volumes': volumes},
            'suunto': {'volumes': [*volumes, {**volumes[1], 'target': '/app/suunto-cloud/.local'}]},
            'web-data-init': {
                'volumes': [{'type': 'volume', 'source': 'smoke-auth', 'target': '/smoke-auth'}],
                'command': ['chmod 0700 /data /smoke-auth && chown "$$1:$$2" /data /smoke-auth',
                            'init', str(os.getuid()), str(os.getgid())],
            },
        },
    }))

    def compose(*args, **kwargs):
        return subprocess.run(['docker', 'compose', '--env-file', os.devnull, '-f', 'compose.yaml',
                               '-f', str(override_path), '-p', project, *args],
                              cwd=repo, env=environment, check=True, **kwargs)

    try:
        configuration = json.loads(compose('--profile', 'cli', 'config', '--format', 'json',
                                          capture_output=True, text=True).stdout)
        for service in ('suunto', 'worker'):
            mounts = {mount['target']: mount for mount in configuration['services'][service]['volumes']}
            for target, volume in [('/auth-config', 'smoke-config'), ('/auth/.local', 'smoke-auth')]:
                assert (mounts[target]['type'], mounts[target]['source']) == ('volume', volume)
        compose('up', '-d', '--build', 'web', 'worker')
        compose('exec', '-T', 'worker', 'node', '--input-type=module', '-',
                input=(repo / 'scripts/docker/test-web-state.mjs').read_text(), text=True)
        address = compose('port', 'web', '3000', capture_output=True, text=True).stdout.strip()
        base = f'http://{address}'
        assert eventually(lambda: request(base, '/api/status')[0]['timeZone']) == 'Europe/Warsaw'
        status, _ = request(base, '/api/status')
        assert not status['interpretationAvailable']
        assert request(base, '/api/workouts')[0]['total'] == 0
        assert b'<html lang="en"' in request(base, '/')[0]
        request(base, '/api/status', headers={'Host': 'unrelated.example'}, expected=403)
        request(base, '/api/sync', body=b'', expected=403)
        request(base, '/api/sync', body=b'', headers={
            'X-Suunto-Request': '1', 'Origin': 'http://unrelated.example',
        }, expected=403)

        settings_path = '/api/suunto/settings'
        settings, _ = request(base, settings_path)
        assert settings == {
            'clientId': None, 'redirectUri': 'http://127.0.0.1:8765/callback',
            'clientSecretSaved': False, 'subscriptionKeySaved': False,
        }
        synthetic_settings = {
            'clientId': 'SYNTHETIC_CLIENT_ID',
            'clientSecret': 'SYNTHETIC_CLIENT_SECRET',
            'subscriptionKey': 'SYNTHETIC_SUBSCRIPTION_KEY',
        }
        body = json.dumps(synthetic_settings).encode()
        json_headers = {'Content-Type': 'application/json'}
        request(base, settings_path, body=body, headers=json_headers, expected=403)
        json_headers.update({'X-Suunto-Request': '1', 'Origin': base})
        settings, headers = request(base, settings_path, body=body, headers=json_headers)
        assert settings == {
            'clientId': 'SYNTHETIC_CLIENT_ID', 'redirectUri': 'http://127.0.0.1:8765/callback',
            'clientSecretSaved': True, 'subscriptionKeySaved': True,
        }
        assert 'no-store' in headers['Cache-Control']
        compose('exec', '-T', 'worker', 'sh', '-ec',
                'test "$(stat -c %a /auth/.local/credentials.json)" = 600')
        change = {**synthetic_settings, 'clientSecret': '', 'subscriptionKey': 'SYNTHETIC_REPLACEMENT_KEY'}
        assert request(base, settings_path, body=json.dumps(change).encode(), headers=json_headers)[0] == settings
        compose('exec', '-T', 'worker', 'python3', '-c',
                'from suunto_cloud.authentication.access import load_credentials; credentials = load_credentials(); '
                'assert credentials["client_secret"] == "SYNTHETIC_CLIENT_SECRET"; '
                'assert credentials["subscription_key"] == "SYNTHETIC_REPLACEMENT_KEY"')

        availability = {'openai': False, 'claude': False}
        assert request(base, '/api/status')[0]['interpretationAvailability'] == availability
        for provider, filename in [('openai', 'openai-api-key'), ('claude', 'anthropic-api-key')]:
            key_path = f'/api/{provider}/settings'
            assert request(base, key_path)[0] == {'configured': False, 'editable': True}
            key_body = json.dumps({'apiKey': f'SYNTHETIC_{provider.upper()}_KEY'}).encode()
            request(base, key_path, body=key_body, headers={'Content-Type': 'application/json'}, expected=403)
            assert request(base, key_path, body=json.dumps({'apiKey': 'bad key'}).encode(),
                           headers=json_headers, expected=400)[0]['error']
            settings_result, headers = request(base, key_path, body=key_body, headers=json_headers)
            assert settings_result == {'configured': True, 'editable': True}
            assert 'no-store' in headers['Cache-Control']
            availability[provider] = True
            assert request(base, '/api/status')[0]['interpretationAvailability'] == availability
            compose('exec', '-T', 'worker', 'sh', '-ec',
                    f'test "$(stat -c %a /auth/.local/{filename})" = 600')

        sync, _ = request(base, '/api/sync', body=b'{}', expected=202, headers={
            'X-Suunto-Request': '1', 'Origin': base, 'Content-Type': 'application/json',
        })
        result_path = f"/api/sync/{sync['jobId']}"
        assert eventually(lambda: request(base, result_path)[0]['status'] == 'failed')
        result, _ = request(base, result_path)
        assert result['error'] and result['added'] == result['updated'] == result['failed'] == 0
        assert request(base, '/api/status')[0]['lastSyncResult'] == result

        content = fit_activity(device_model='Suunto Race 2', gps=True)
        assert upload(base, content)['files'][0]['status'] == 'queued'
        workout = eventually(lambda: ready_workout(base, 1))
        path = '/workouts/' + workout['id']
        details, headers = request(base, '/api' + path)
        assert details['chart'] and details['source'] == 'fit'
        assert details['distanceM'] == 180 and details['activeSeconds'] == 60
        assert details['deviceModel'] == 'Suunto Race 2'
        assert details['interpretation'] is None and 'interpretationStatus' not in details
        assert details['interpretations'] == {'openai': {'result': None}, 'claude': {'result': None}}
        request(base, '/api' + path + '/interpret?provider=unknown', body=b'{}', headers=json_headers, expected=400)
        assert 'no-store' in headers['Cache-Control']
        chart, headers = request(base, '/api' + path + '/chart')
        assert b'chart-data' in chart and 'sandbox' in headers['Content-Security-Policy']
        assert b'Workout overview' in chart and '⌚</tspan> Suunto Race 2</text>'.encode() in chart
        polish_chart, headers = request(base, '/api' + path + '/chart?lang=pl')
        assert headers['Content-Language'] == 'pl' and b'<html lang="pl"' in polish_chart
        assert 'Czas aktywny' in polish_chart.decode()
        assert 'Przypnij pozycję' in polish_chart.decode()
        assert '⌚</tspan> Suunto Race 2</text>' in polish_chart.decode()
        for language in ('en', 'pl'):
            embedded, headers = request(base, '/api' + path + f'/chart?lang={language}&embed=1')
            assert headers['Content-Language'] == language
            assert b'suunto-chart-height' in embedded and b'chart-data' in embedded
            assert b'suunto-chart-cursor' in embedded and b'main > .help { display: none; }' in embedded
        assert b'suunto-chart-height' not in chart
        assert b'suunto-chart-cursor' not in chart
        preview, _ = request(base, '/api' + path + '/route')
        route, headers = request(base, '/api' + path + '/route?view=map')
        assert 'no-store' in headers['Cache-Control']
        assert [point[2] for point in route['segments'][0]] == list(range(61))
        assert len(preview['segments'][0]) == len(route['segments'][0])
        assert all(len(point) == 2 for point in preview['segments'][0])
        assert b'<html lang="en"' in request(base, path)[0]
        request(base, '/api' + path + '/source.fit', expected=404)
        assert upload(base, content)['files'][0]['status'] == 'duplicate'
        assert request(base, '/api/workouts')[0]['total'] == 1
        compose('exec', '-T', 'web', 'sh', '-ec',
                'test ! -e /auth && test "$(stat -c %a /data/library.sqlite)" = 600')

        compose('down')
        compose('up', '-d', 'web', 'worker')
        address = compose('port', 'web', '3000', capture_output=True, text=True).stdout.strip()
        base = f'http://{address}'
        assert eventually(lambda: ready_workout(base, 1))['id'] == workout['id']
        assert request(base, '/api/status')[0]['lastSyncResult'] == result
        assert request(base, settings_path)[0] == settings
        for provider in availability:
            assert request(base, f'/api/{provider}/settings')[0] == {'configured': True, 'editable': True}
        assert request(base, '/api' + path + '/chart')[0] == chart
        request(base, '/api' + path + '/retry', body=b'{}', headers={
            'X-Suunto-Request': '1', 'Origin': base, 'Content-Type': 'application/json',
        }, expected=202)
        eventually(lambda: request(base, '/api' + path)[0]['analysisVersion'] > details['analysisVersion'])
        assert upload(base, fit_activity(1_000_100_000))['files'][0]['status'] == 'queued'
        indoor = eventually(lambda: ready_workout(base, 2))
        assert indoor['id'] != workout['id']
        empty_route, _ = request(base, '/api/workouts/' + indoor['id'] + '/route?view=map')
        assert empty_route == {'segments': None}
        corrupt = content[:-1] + bytes([content[-1] ^ 0xFF])
        invalid = upload(base, corrupt)['files'][0]
        assert invalid['status'] == 'queued'
        invalid_path = '/api/workouts/' + invalid['id']
        eventually(lambda: request(base, invalid_path)[0]['status'] == 'failed')
        assert request(base, '/api' + path + '/chart')[0] == chart
        errors_path = '/api/jobs/errors'
        errors, _ = request(base, errors_path)
        assert [job['kind'] for job in errors['errors']] == ['analyze', 'sync']
        assert errors['errors'][0]['workoutId'] == invalid['id'] and errors['errors'][0]['error']
        assert request(base, '/api/status')[0]['jobs']['failed'] == 2
        request(base, errors_path, method='DELETE', expected=403)
        action_headers = {'X-Suunto-Request': '1', 'Origin': base}
        request(base, f'{errors_path}/{sync["jobId"]}', method='DELETE', headers=action_headers, expected=204)
        assert [job['kind'] for job in request(base, errors_path)[0]['errors']] == ['analyze']
        assert request(base, '/api/status')[0]['jobs']['failed'] == 1
        request(base, errors_path, method='DELETE', headers=action_headers, expected=204)
        assert request(base, errors_path)[0] == {'errors': []}
        assert request(base, '/api/status')[0]['jobs']['failed'] == 0
        assert request(base, invalid_path)[0]['status'] == 'failed'
        assert request(base, result_path)[0]['status'] == 'failed'

        for provider, filename in [('claude', 'anthropic-api-key'), ('openai', 'openai-api-key')]:
            key_path = f'/api/{provider}/settings'
            request(base, key_path, method='DELETE', expected=403)
            assert request(base, key_path, method='DELETE', headers=action_headers)[0] == {
                'configured': False, 'editable': True,
            }
            availability[provider] = False
            assert request(base, '/api/status')[0]['interpretationAvailability'] == availability
            compose('exec', '-T', 'worker', 'sh', '-ec', f'test ! -e /auth/.local/{filename}')
        print('Web smoke test passed: private settings, job errors, FIT device, GPS routes, chart isolation, '
              'deduplication, and persistence.')
    except Exception:
        compose('logs', '--tail', '45', 'web', 'worker')
        raise
    finally:
        compose('down', '-v')


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as directory:
        main(Path(directory) / 'compose.json')
