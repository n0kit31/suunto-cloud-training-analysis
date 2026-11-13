"""Derive pause intervals and lap summaries without interpolating missing samples."""

from datetime import datetime

from suunto_cloud.analysis.metrics import additional_details
from suunto_cloud.timezones import timezone_name


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def local_time(value, zone=None):
    return stamp(value).astimezone(zone).isoformat()


def timer_intervals(events):
    active = False
    active_start = None
    pause_start = None
    pauses = []
    segments = []
    repeated_stops = []
    for event in sorted(events, key=lambda e: stamp(e['timestamp'])):
        if event.get('event') != 'timer':
            continue
        when = event['timestamp']
        if event.get('event_type') == 'start':
            if pause_start is not None:
                pauses.append({'start': pause_start, 'end': when,
                               'seconds': (stamp(when) - stamp(pause_start)).total_seconds()})
                pause_start = None
            if not active:
                active_start = when
                active = True
        elif event.get('event_type') in ('stop', 'stop_all', 'stop_disable', 'stop_disable_all'):
            if active:
                segments.append({'start': active_start, 'end': when,
                                 'seconds': (stamp(when) - stamp(active_start)).total_seconds()})
                active = False
                pause_start = when
            elif pause_start is not None:
                repeated_stops.append(when)
    # The final stop at session end has no subsequent start and is not a pause.
    return {'pauses': pauses, 'active_segments': segments, 'repeated_stop_events': repeated_stops,
            'pause_seconds_from_rounded_events': sum(p['seconds'] for p in pauses)}


def summarize(data, zone=None):
    session = data['sessions'][0]
    timer = timer_intervals(data.get('events', []))
    segments = [(stamp(p['start']), stamp(p['end'])) for p in timer['active_segments']]

    def active(record):
        when = stamp(record['timestamp'])
        return any(start <= when < end for start, end in segments)

    records = data.get('records', [])
    measured = [r for r in records if isinstance(r.get('heart_rate'), (int, float)) and active(r)]
    peak = max((r['heart_rate'] for r in measured), default=None)
    peaks = [{k: r[k] for k in ('timestamp', 'distance', 'heart_rate', 'altitude', 'speed', 'power') if k in r}
             for r in measured if r['heart_rate'] == peak]
    laps = []
    for index, lap in enumerate(data.get('laps', []), 1):
        distance = lap.get('total_distance', 0)
        elapsed = lap.get('total_elapsed_time')
        duration = lap.get('total_timer_time')
        laps.append({'index': index, 'trigger': lap.get('lap_trigger'), 'start_local': local_time(lap['start_time'], zone),
                     'end_local': local_time(lap['timestamp'], zone), 'distance_m': distance,
                     'active_seconds': duration, 'elapsed_seconds': elapsed,
                     'pace_seconds_per_km': duration / (distance / 1000) if distance and duration is not None else None,
                     'avg_hr': lap.get('avg_heart_rate'), 'max_hr': lap.get('max_heart_rate'),
                     'avg_power_w': lap.get('avg_power'), 'ascent_m': lap.get('total_ascent'),
                     'descent_m': lap.get('total_descent')})
    rr_count = sum(len(row['time']) if isinstance(row.get('time'), list) else 0 for row in data.get('hrv', []))
    result = {'session': session, 'timezone': timezone_name(zone), 'timer': timer, 'laps': laps, 'record_count': len(records),
              'active_hr_sample_count': len(measured), 'active_hr_arithmetic_mean':
                  sum(r['heart_rate'] for r in measured) / len(measured) if measured else None,
              'hr_peak_records_active_only': peaks, 'hrv_message_count': len(data.get('hrv', [])),
              'rr_interval_count': rr_count, 'ddfa_sample_count': sum('ddfa' in r for r in records),
              'gps_sample_count': sum('position_lat' in r and 'position_long' in r for r in records),
              'notes': ['Timer events have whole-second timestamps; use session total_timer_time for exact duration.',
                        'Arithmetic sample HR is descriptive, not a substitute for the device weighted average.',
                        'No R-R artifact assessment or medical HRV analysis was performed.']}
    if peaks:
        peak_time = stamp(peaks[0]['timestamp'])
        earlier = [r for r in records if 'altitude' in r and 'timestamp' in r and
                   55 <= (peak_time - stamp(r['timestamp'])).total_seconds() <= 65 and active(r)]
        if earlier and 'altitude' in peaks[0]:
            reference = min(earlier, key=lambda r: abs((peak_time - stamp(r['timestamp'])).total_seconds() - 60))
            result['altitude_change_around_60s_before_hr_peak_m'] = peaks[0]['altitude'] - reference['altitude']
    result['additional_metrics'] = additional_details(data, timer)
    return result
