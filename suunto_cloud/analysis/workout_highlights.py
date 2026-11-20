"""Read workout conditions and date the recovery estimate in workout local time."""

from datetime import datetime, timedelta, timezone

from suunto_cloud.analysis.metrics import number
from suunto_cloud.timezones import resolve_timezone


def cloud_recovery_times(workout):
    return {'cumulative_recovery_seconds': workout.get('cumulativeRecoveryTime'),
            'workout_recovery_seconds': workout.get('recoveryTime')}


def celsius_from_kelvin(value):
    return value - 273.15 if number(value) and value > 0 else None


def workout_highlights(cloud, analysis):
    summary = cloud.get('summary') or {}
    session = analysis.get('session') or {}
    temperature = celsius_from_kelvin(summary.get('avgTemperature'))
    if temperature is None and number(session.get('avg_temperature')):
        temperature = session['avg_temperature']

    recorded = ((cloud.get('cumulative_recovery_seconds'), 'cumulative'),
                (cloud.get('workout_recovery_seconds'), 'workout'),
                (summary.get('recoveryTime'), 'workout'), (session.get('recovery_time'), 'workout'))
    seconds, kind = next(((seconds, kind) for seconds, kind in recorded
                          if number(seconds) and 0 <= seconds <= 315360000), (None, None))
    until = None
    if seconds is not None and cloud.get('stop_local'):
        stop = datetime.fromisoformat(cloud['stop_local'])
        if stop.utcoffset() is not None:
            name = cloud.get('timezone')
            zone = resolve_timezone(name) if name and name != 'system local' else stop.tzinfo
            until = (stop.astimezone(timezone.utc) + timedelta(seconds=seconds)).astimezone(zone).isoformat()
    return {'temperature_c': temperature, 'recovery_seconds': seconds,
            'recovery_kind': kind, 'recovery_until': until}
