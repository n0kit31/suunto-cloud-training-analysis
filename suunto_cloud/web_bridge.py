"""Machine-readable access to the existing Suunto analysis for the local web worker."""

import argparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from urllib.error import HTTPError, URLError
from zoneinfo import ZoneInfo

from suunto_cloud.activities import activity_label, foot_activity
from suunto_cloud.analysis.chart_summary import chart_summary
from suunto_cloud.analysis.fit import stamp, summarize
from suunto_cloud.analysis.metrics import number
from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.authentication.access import (
    AccessError, RefreshHTTPError, authorized_call, is_current, load_credentials, load_tokens,
)
from suunto_cloud.authentication.web_settings import InvalidSettings, read_settings, save_settings
from suunto_cloud.downloads.tracks import FIT_MAX_BYTES, choose_workout, fetch_fit, save_fit
from suunto_cloud.downloads.workouts import date_cutoff, fetch_workouts, paginated_workouts
from suunto_cloud.fit import decode_fit
from suunto_cloud.fit.import_command import fit_summary
from suunto_cloud.reporting.interactive import chart_html
from suunto_cloud.reporting.reports import chart_svg
from suunto_cloud.reporting.summary import summary_observations
from suunto_cloud.storage.local import authentication_directory, private_text, user_timezone

LAP_METRICS = {
    'distanceM': 'distance_m', 'activeSeconds': 'active_seconds',
    'elapsedSeconds': 'elapsed_seconds', 'paceSecondsPerKm': 'pace_seconds_per_km',
    'avgHr': 'avg_hr', 'maxHr': 'max_hr', 'avgPowerW': 'avg_power_w',
    'ascentM': 'ascent_m', 'descentM': 'descent_m',
}


class BridgeError(Exception):
    def __init__(self, code, message, retry_after_ms=None):
        super().__init__(message)
        self.code = code
        self.retry_after_ms = retry_after_ms

    def response(self):
        error = {'code': self.code, 'message': str(self)}
        if self.retry_after_ms is not None:
            error['retryAfterMs'] = self.retry_after_ms
        return {'error': error}


def retry_delay(header):
    if not header:
        return None
    if header.isascii() and header.isdecimal() and len(header) <= 9:
        return int(header) * 1000
    try:
        deadline = parsedate_to_datetime(header)
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return max(0, round((deadline - datetime.now(timezone.utc)).total_seconds() * 1000))
    except (TypeError, ValueError, OverflowError):
        return None


def api_error(status, retry_after, fit_download):
    if status == 429:
        return BridgeError('RATE_LIMIT', 'Suunto rate limit reached. Try again later.', retry_delay(retry_after))
    if status in (401, 403):
        return BridgeError('AUTH_REQUIRED', 'Suunto authorization or the API subscription needs attention.')
    if fit_download and status in (404, 410):
        return BridgeError('FIT_UNAVAILABLE', 'A FIT file is unavailable for this activity.')
    if status == 408 or status >= 500:
        return BridgeError('NETWORK', 'Suunto is temporarily unavailable.')
    return BridgeError('ANALYSIS_FAILED', 'Suunto rejected the request.')


def authorization_revision():
    try:
        credentials = load_credentials()
        tokens = load_tokens()
    except (AccessError, OSError, ValueError, TypeError):
        return None
    can_refresh = (isinstance(tokens.get('refresh_token'), str)
                   and tokens['refresh_token'] and credentials.get('client_secret'))
    if not credentials.get('subscription_key', '').strip() or not (is_current(tokens) or can_refresh):
        return None
    path = authentication_directory() / 'credentials.json'
    try:
        saved = path.stat()
        credentials_revision = (saved.st_mtime_ns, saved.st_ino)
    except FileNotFoundError:
        credentials_revision = None
    # Automatic token refresh preserves the sign-in ID. It must not trigger a new import after rejection.
    revision = (credentials['client_id'], credentials_revision, tokens.get('authorization_id'))
    return hashlib.sha256(json.dumps(revision).encode()).hexdigest()


def web_timezone():
    return user_timezone() or ZoneInfo('UTC')


def numeric(value):
    return value if number(value) else None


def first_metric(*values):
    return next((value for value in values if number(value)), None)


def summary_fields(cloud, decoded):
    session = (decoded.get('sessions') or [{}])[0]
    return {
        'startedAt': round(stamp(cloud['start_local']).timestamp() * 1000),
        'sport': activity_label(cloud, decoded) or 'Activity',
        'distanceM': first_metric(cloud.get('distance_m'), session.get('total_distance')),
        'activeSeconds': first_metric(cloud.get('active_seconds'), session.get('total_timer_time')),
        'avgHr': first_metric(cloud.get('avg_hr_bpm'), session.get('avg_heart_rate')),
    }


def list_pages(cutoff):
    interval = int(os.environ.get('SUUNTO_REQUEST_INTERVAL_MS', '6500')) / 1000
    next_request = 0

    def fetch(token, key, query):
        nonlocal next_request
        remaining = next_request - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)
        next_request = time.monotonic() + interval
        return fetch_workouts(token, key, **query)

    return paginated_workouts(lambda **query: authorized_call(
        lambda token, key: fetch(token, key, query)), cutoff=cutoff)


def list_workouts(since_days, modified_since):
    zone = web_timezone()
    before_scan = datetime.now(timezone.utc)
    cutoff = modified_since
    if since_days is not None:
        day = before_scan.astimezone(zone).date() - timedelta(days=since_days - 1)
        cutoff = date_cutoff(day, zone)
    data = list_pages(cutoff)
    workouts = []
    modifications = []
    for record in data['payload']:
        started = record.get('startTime')
        modified = record.get('lastModified')
        if type(started) is not int or (modified_since is not None and type(modified) is not int):
            raise ValueError('Invalid Suunto workout timestamp.')
        if type(modified) is int and modified >= 0:
            modifications.append(modified)
        else:
            modified = None
        selected_time = started if since_days is not None else modified
        if selected_time is None or selected_time < cutoff:
            continue
        choose_workout([record], workout_key=record['workoutKey'])
        workouts.append({
            'sourceKey': record['workoutKey'], 'modifiedAt': modified,
            **summary_fields(cloud_metrics(record, zone), {}), 'cloud': record,
        })
    if modifications:
        high_watermark = min(round(before_scan.timestamp() * 1000), max(modifications))
    elif data['payload']:
        # Without a modification timestamp, refetch rather than skipping potentially unseen workouts.
        high_watermark = cutoff
    else:
        high_watermark = round(before_scan.timestamp() * 1000)
    result = {'workouts': workouts, 'highWatermark': max(0, cutoff, high_watermark)}
    if getattr(zone, 'key', None):
        result['timeZone'] = zone.key
    return result


def workout_metrics(cloud, analysis, context, summary):
    session = analysis['session']
    timer = analysis['timer']
    highlights = context['highlights']
    on_foot = foot_activity(cloud, session.get('sport'))
    cadence = numeric(session.get('avg_cadence'))
    return {
        'maxHr': first_metric(cloud.get('max_hr_bpm'), session.get('max_heart_rate')),
        'ascentM': first_metric(cloud.get('ascent_m'), session.get('total_ascent')),
        'descentM': first_metric(cloud.get('descent_m'), session.get('total_descent')),
        'elapsedSeconds': first_metric(session.get('total_elapsed_time'), cloud.get('elapsed_seconds')),
        'paceSecondsPerKm': (summary['activeSeconds'] / (summary['distanceM'] / 1000)
                             if summary['distanceM'] and summary['distanceM'] > 0
                             and summary['activeSeconds'] is not None else None),
        'avgPowerW': numeric(session.get('avg_power')),
        'maxPowerW': numeric(session.get('max_power')),
        'avgCadence': cadence * (2 if on_foot else 1) if cadence is not None else None,
        'cadenceUnit': ('spm' if on_foot else 'rpm') if cadence is not None else None,
        'energyKcal': first_metric(cloud.get('energy_kcal'), session.get('total_calories')),
        'pauseSeconds': numeric(timer.get('pause_seconds_from_rounded_events')) if timer['active_segments'] else None,
        'hrTss': numeric(context['workout'].get('hr_tss')),
        'temperatureC': numeric(highlights.get('temperature_c')),
        'recoverySeconds': numeric(highlights.get('recovery_seconds')),
        'recordCount': analysis['record_count'],
        'activeHrSampleCount': analysis['active_hr_sample_count'],
    }


def read_fit(path):
    with path.open('rb') as stream:
        content = stream.read(FIT_MAX_BYTES + 1)
    if len(content) > FIT_MAX_BYTES or len(content) < 12 or content[8:12] != b'.FIT':
        raise BridgeError('INVALID_FIT', 'The input is not a FIT file within the 64 MiB limit.')
    return content


# Suunto API Zone's DeviceProductIDs table, plus Vertical 2 verified from a FIT file ID.
# https://aspartnercontent.blob.core.windows.net/apizone/docs/DeviceProductIDs.pdf
SUUNTO_DEVICE_MODELS = {
    22: 'Suunto Ambit3 Peak', 28: 'Suunto Spartan Sport', 29: 'Suunto Spartan Ultra',
    34: 'Suunto 9 Baro', 35: 'Suunto 9', 36: 'Suunto 5', 40: 'Suunto 7',
    42: 'Suunto 9 Peak', 56: 'Suunto 5 Peak', 67: 'Suunto Vertical 2',
}


def recording_device_model(decoded):
    creators = [entry for entry in decoded.get('file_ids', []) if entry.get('type') in ('activity', 4)]
    onboard = [entry for entry in decoded.get('device_infos', [])
               if entry.get('device_index') in (0, 'creator')]
    for entry in creators + onboard:
        value = entry.get('product_name')
        if isinstance(value, str):
            model = value.strip()
            if 0 < len(model) <= 80 and model.isprintable():
                return model
        if entry.get('manufacturer') in (23, 'suunto'):
            product = entry.get('product')
            if type(product) is int and product in SUUNTO_DEVICE_MODELS:
                return SUUNTO_DEVICE_MODELS[product]
    return None


def read_device_model(fit_path):
    if not fit_path.is_file():
        return {'deviceModel': None}
    with TemporaryDirectory() as scratch:
        decoded = decode_fit(fit_path, Path(scratch) / 'decoded.json')
    return {'deviceModel': recording_device_model(decoded)}


def download_fit(source_key):
    def download(token, key):
        try:
            return fetch_fit(source_key, token, key)
        except ValueError:
            raise BridgeError('FIT_UNAVAILABLE', 'Suunto did not return a usable FIT file.') from None

    return authorized_call(download)


def analyze_workout(workspace, cloud_path, fit_path):
    zone = web_timezone()
    cloud_record = None
    if cloud_path:
        cloud_record = json.loads(cloud_path.read_text())
        if not isinstance(cloud_record, dict):
            raise ValueError('Cloud workout must be a record.')
        source_key = cloud_record.get('workoutKey')
        choose_workout([cloud_record], workout_key=source_key)
    content = read_fit(fit_path) if fit_path else download_fit(source_key)
    artifact = workspace / 'source.fit'
    save_fit(artifact, content)
    with TemporaryDirectory(dir=workspace) as scratch:
        try:
            decoded = decode_fit(artifact, Path(scratch) / 'decoded.json')
            cloud = cloud_metrics(cloud_record, zone) if cloud_record is not None else fit_summary(decoded, zone)
            analysis = summarize(decoded, zone)
        except (ValueError, KeyError, IndexError, TypeError, AttributeError, ArithmeticError):
            if cloud_record is not None and not fit_path:
                raise BridgeError('FIT_UNAVAILABLE', 'Suunto returned a FIT file that could not be analyzed.') from None
            raise BridgeError('INVALID_FIT', 'The FIT could not be analyzed. Local uploads require one workout session.') from None

    summary = summary_fields(cloud, decoded)
    context = chart_summary(cloud, analysis)
    interaction = {}
    svg = chart_svg(decoded, analysis, cloud, interaction=interaction)
    if svg:
        private_text(workspace / 'chart.html', chart_html(svg, interaction, 'workout.svg'))
    preferred = set(analysis['additional_metrics']['preferred_lap_indices'])
    laps = [{'index': lap['index'], **{target: numeric(lap.get(source)) for target, source in LAP_METRICS.items()}}
            for lap in analysis['laps'] if lap['index'] in preferred]
    return {
        'summary': summary, 'metrics': workout_metrics(cloud, analysis, context, summary),
        'laps': laps, 'observations': summary_observations(context),
        'fitSha256': hashlib.sha256(content).hexdigest(), 'chart': bool(svg),
        'deviceModel': recording_device_model(decoded),
    }


def run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    listing = commands.add_parser('list')
    scope = listing.add_mutually_exclusive_group(required=True)
    scope.add_argument('--since-days', type=int, choices=range(1, 367), metavar='DAYS')
    scope.add_argument('--modified-since', type=int, metavar='EPOCH_MS')
    analysis = commands.add_parser('analyze')
    analysis.add_argument('--workspace', type=Path, required=True)
    analysis.add_argument('--cloud', type=Path)
    analysis.add_argument('--fit', type=Path)
    device = commands.add_parser('device-model')
    device.add_argument('--fit', type=Path, required=True)
    commands.add_parser('auth-status')
    commands.add_parser('settings-read')
    commands.add_parser('settings-save')
    args = parser.parse_args(argv)
    fit_download = args.command == 'analyze' and args.fit is None
    try:
        if args.command == 'list':
            if args.modified_since is not None and args.modified_since < 0:
                raise BridgeError('ANALYSIS_FAILED', 'The modification cutoff must be nonnegative.')
            response = list_workouts(args.since_days, args.modified_since)
        elif args.command == 'analyze':
            if not args.workspace.is_absolute() or (args.fit is None and args.cloud is None):
                raise BridgeError('ANALYSIS_FAILED', 'A private workspace and a workout source are required.')
            response = analyze_workout(args.workspace, args.cloud, args.fit)
        elif args.command == 'device-model':
            response = read_device_model(args.fit)
        elif args.command == 'auth-status':
            revision = authorization_revision()
            response = {'authorized': revision is not None, 'revision': revision, 'timeZone': web_timezone().key}
        elif args.command == 'settings-read':
            response = read_settings()
        else:
            try:
                payload = json.loads(sys.stdin.read(8193))
            except ValueError:
                raise InvalidSettings('Check the format of your Suunto credentials.') from None
            response = save_settings(payload)
        result = json.dumps(response, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    except BridgeError as caught:
        error = caught
    except RefreshHTTPError as caught:
        error = api_error(caught.status, caught.retry_after, False)
    except HTTPError as caught:
        with caught:
            error = api_error(caught.code, caught.headers.get('Retry-After') if caught.headers else None, fit_download)
    except (URLError, HTTPException, ConnectionError, TimeoutError):
        error = BridgeError('NETWORK', 'Could not reach Suunto.')
    except AccessError:
        error = BridgeError('AUTH_REQUIRED', 'Complete Suunto authorization and verify the API subscription.')
    except InvalidSettings as caught:
        error = BridgeError('SETTINGS_INVALID', str(caught))
    except (OSError, ValueError, ArithmeticError, TypeError, KeyError, AttributeError, IndexError, EOFError):
        error = BridgeError('ANALYSIS_FAILED', 'The workout operation could not be completed.')
    else:
        print(result)
        return 0
    print(json.dumps(error.response(), ensure_ascii=False, separators=(',', ':')))
    return 1


if __name__ == '__main__':
    sys.exit(run())
