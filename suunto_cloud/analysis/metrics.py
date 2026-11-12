"""Reusable sample calculations; never interpolate missing observations."""

from bisect import bisect_left, bisect_right
from collections import Counter
from datetime import datetime
import math
from statistics import mean


def seconds(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def active_samples(data, timer):
    intervals = [(seconds(s['start']), seconds(s['end'])) for s in timer['active_segments']]
    rows = sorted(((seconds(r['timestamp']), r) for r in data.get('records', []) if r.get('timestamp')),
                  key=lambda item: item[0])
    result = []
    index = 0
    for when, row in rows:
        while index < len(intervals) and when >= intervals[index][1]:
            index += 1
        if index < len(intervals) and intervals[index][0] <= when < intervals[index][1]:
            result.append((when, row))
    return result


def sample_statistics(rows):
    fields = ('heart_rate', 'speed', 'power', 'cadence', 'stance_time', 'vertical_oscillation', 'ddfa')
    counts = Counter(k for _, r in rows for k in fields if number(r.get(k)))
    paired = [r for _, r in rows
              if all(number(r.get(k)) for k in ('speed', 'cadence', 'stance_time', 'vertical_oscillation'))
              and r['speed'] > 0 and r['cadence'] > 0]
    result = {'record_count': len(rows), 'field_sample_counts': dict(counts),
              'mechanics_paired_count': len(paired)}
    if paired:
        result['mechanics'] = {
            'cadence_steps_per_min': mean(2 * r['cadence'] for r in paired),
            'ground_contact_ms': mean(r['stance_time'] for r in paired),
            'vertical_oscillation_cm': mean(r['vertical_oscillation'] / 10 for r in paired),
            'estimated_step_length_m': mean(30 * r['speed'] / r['cadence'] for r in paired),
        }
    return result


def additional_details(data, timer):
    rows = active_samples(data, timer)
    times = [t for t, _ in rows]
    laps = list(enumerate(data.get('laps', []), 1))
    guided = [(i, l) for i, l in laps if l.get('event') == 'workout_step']
    selected = guided or [(i, l) for i, l in laps if l.get('lap_trigger') == 'distance'] or laps
    lap_samples = []
    for index, lap in selected:
        start, end = seconds(lap['start_time']), seconds(lap['timestamp'])
        observations = rows[bisect_left(times, start):bisect_left(times, end)]
        lap_samples.append({'lap_index': index, **sample_statistics(observations)})

    hr_rows = [(t, r['heart_rate']) for t, r in rows if number(r.get('heart_rate'))]
    hr_times = [t for t, _ in hr_rows]

    def hr_at(target, strictly_before=False, not_before=None):
        index = (bisect_left(hr_times, target) if strictly_before else bisect_right(hr_times, target)) - 1
        if index < 0:
            return None
        when, value = hr_rows[index]
        if target - when > 3 or (not_before is not None and when < not_before):
            return None
        return {'bpm': value, 'age_seconds': target - when}

    recoveries = []
    for (index, work), (next_index, rest) in zip(guided, guided[1:]):
        distance, duration = work.get('total_distance'), work.get('total_timer_time')
        next_distance, next_duration = rest.get('total_distance'), rest.get('total_timer_time')
        if not all(number(v) and v > 0 for v in (distance, duration, next_distance, next_duration)):
            continue
        if distance / duration <= next_distance / next_duration:
            continue
        start, end = seconds(rest['start_time']), seconds(rest['timestamp'])
        work_end = seconds(work['timestamp'])
        if abs(start - work_end) > 2:
            continue
        pauses = [(seconds(p['start']), seconds(p['end'])) for p in timer['pauses']]
        paused = any(a < end and b > start for a, b in pauses)
        initial = hr_at(work_end, not_before=seconds(work['start_time']))
        after60 = hr_at(start + 60, not_before=start) if end > start + 60 and not paused else None
        last = hr_at(end, not_before=start)
        recoveries.append({'work_lap_index': index, 'slower_next_lap_index': next_index,
                           'pause_in_next_lap': paused, 'hr_at_work_end': initial,
                           'hr_after_60_elapsed_seconds': after60, 'hr_at_next_lap_end': last,
                           'hr_drop_after_60_seconds': initial['bpm'] - after60['bpm']
                           if initial and after60 else None})

    channels = []
    for field in data.get('field_descriptions', []):
        label, name = field.get('suuntoplus_field_label'), field.get('field_name')
        if not label or not name:
            continue
        values = [(t, r[name]) for t, r in rows if number(r.get(name))]
        summary = data.get('sessions', [{}])[0].get(name)
        channels.append({'field': name, 'label': label, 'unit': field.get('units'),
                         'active_sample_count': len(values),
                         'first_active_value': values[0][1] if values else None,
                         'last_active_value': values[-1][1] if values else None,
                         'session_value': summary})
    altitude = [(t, r['altitude'], r.get('distance')) for t, r in rows if number(r.get('altitude'))]
    profile = None
    if altitude:
        minimum, maximum = min(altitude, key=lambda x: x[1]), max(altitude, key=lambda x: x[1])
        profile = {'first_altitude_m': altitude[0][1], 'last_altitude_m': altitude[-1][1],
                   'minimum_altitude_m': minimum[1], 'maximum_altitude_m': maximum[1],
                   'minimum_at_distance_m': minimum[2], 'maximum_at_distance_m': maximum[2]}
    return {'method': 'Arithmetic means of joint observed active samples; no interpolation. '
                     'Cadence cycles/min x2; vertical oscillation mm/10; stance time ms; '
                     'step length = 30 * speed_mps / cadence_cycles_per_min. '
                     'HR changes use last observed values no older than 3 seconds; not a clinical HRR test.',
            'active': sample_statistics(rows), 'preferred_lap_kind': 'guided' if guided else 'other',
            'preferred_lap_indices': [i for i, _ in selected], 'lap_samples': lap_samples,
            'slower_next_lap_hr_changes': recoveries, 'suuntoplus_channels': channels,
            'altitude_profile': profile,
            'steady_state_metrics': 'Require comparable steady active segments; not inferred automatically.',
            'rr_artifact_assessment': 'Not performed; RR counts do not constitute an HRV interpretation.'}
