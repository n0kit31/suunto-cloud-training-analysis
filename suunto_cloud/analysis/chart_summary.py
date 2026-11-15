"""Factual workout and calendar-week comparisons, independent of files and APIs."""

from datetime import datetime, timedelta

from suunto_cloud.activities import activity_label
from suunto_cloud.analysis.metrics import number
from suunto_cloud.timezones import resolve_timezone


def activity_group(cloud):
    activity = cloud.get('activity_id')
    if activity in (1, 22, 53, 103, 115):
        return 'Running'
    if activity in (0, 11, 24, 70):
        return 'Walking / hiking'
    return activity_label(cloud, {}) or 'Other activity'


def session(cloud):
    keys = ('workout_key', 'activity_id', 'activity_name', 'start_local', 'distance_m',
            'active_seconds', 'pace_seconds_per_km', 'avg_hr_bpm', 'max_hr_bpm', 'ascent_m')
    result = {key: cloud.get(key) for key in keys}
    tss = cloud.get('tss') or {}
    result['hr_tss'] = (tss.get('trainingStressScore')
                        if tss.get('calculationMethod') == 'HR' and number(tss.get('trainingStressScore'))
                        else cloud.get('hr_tss'))
    if not number(result['hr_tss']):
        result['hr_tss'] = None
    result['activity'] = activity_label(cloud, {}) or 'Activity'
    result['group'] = activity_group(cloud)
    return result


def split_pattern(analysis):
    preferred = (analysis.get('additional_metrics') or {}).get('preferred_lap_indices')
    laps = [lap for lap in analysis.get('laps', [])
            if (preferred is None or lap['index'] in preferred)
            and number(lap.get('distance_m')) and abs(lap['distance_m'] - 1000) < .01
            and number(lap.get('pace_seconds_per_km'))]
    # Describe observed splits, not programmed intervals or a physiological classification.
    fast = [i for i in range(1, len(laps) - 1)
            if laps[i - 1]['index'] + 1 == laps[i]['index'] == laps[i + 1]['index'] - 1
            and laps[i]['pace_seconds_per_km'] + 25 <= min(
                laps[i - 1]['pace_seconds_per_km'], laps[i + 1]['pace_seconds_per_km'])]
    if len(fast) < 3 or any(b - a != 2 for a, b in zip(fast, fast[1:])):
        return None
    work = [laps[i] for i in fast]
    slower = [laps[i + 1] for i in fast]
    return {'count': len(work), 'distance_m_each': 1000,
            'fast_pace_range': [min(l['pace_seconds_per_km'] for l in work),
                                max(l['pace_seconds_per_km'] for l in work)],
            'slower_pace_range': [min(l['pace_seconds_per_km'] for l in slower),
                                  max(l['pace_seconds_per_km'] for l in slower)],
            'method': 'At least three alternating full-kilometre laps, each at least 25 s/km '
                      'faster than both neighbours. Describes recorded splits; terrain may affect pace.'}


def chart_summary(cloud, analysis, peers=None):
    current = session(cloud)
    origin = datetime.fromisoformat(cloud['start_local'])
    name = cloud.get('timezone')
    zone = resolve_timezone(name) if name and name != 'system local' else origin.tzinfo
    current['start_local'] = origin.astimezone(zone).isoformat()
    day = origin.astimezone(zone).date()
    monday = day - timedelta(days=day.weekday())
    sunday = monday + timedelta(days=6)
    unique = {}
    for source in [*(peers or []), cloud]:
        row = session(source)
        try:
            local = datetime.fromisoformat(row['start_local']).astimezone(zone)
        except (TypeError, ValueError):
            continue
        if not monday <= local.date() <= sunday:
            continue
        row['start_local'] = local.isoformat()
        key = row['workout_key'] or (row['activity_id'], row['start_local'])
        unique[key] = row
    rows = sorted(unique.values(), key=lambda row: datetime.fromisoformat(row['start_local']).timestamp())
    comparable = [row for row in rows if row['group'] == current['group']]

    def total(items, field):
        values = [row[field] for row in items if number(row[field])]
        return sum(values) if values else None

    totals = {field: total(comparable, field) for field in ('distance_m', 'active_seconds', 'hr_tss')}
    totals['hr_tss_count'] = sum(number(row['hr_tss']) for row in comparable)
    ranks = {}
    for field in ('distance_m', 'hr_tss'):
        value = current[field]
        values = [row[field] for row in comparable if number(row[field])]
        ranks[field] = ('highest' if values.count(value) == 1 else 'joint_highest') if (
            len(comparable) > 1 and len(values) == len(comparable) and number(value) and value == max(values)) else None
    other = []
    for group in sorted({row['group'] for row in rows} - {current['group']}):
        items = [row for row in rows if row['group'] == group]
        other.append({'group': group, 'count': len(items), 'distance_m': total(items, 'distance_m'),
                      'active_seconds': total(items, 'active_seconds')})
    zones = (((cloud.get('intensity') or {}).get('zones') or {}).get('heartRate') or {})
    classified = sum(value.get('totalTime', 0) for value in zones.values()
                     if number(value.get('totalTime')))
    def zone_total(keys):
        values = [zones.get(key, {}).get('totalTime') for key in keys]
        return sum(value for value in values if number(value))
    easy, high = zone_total(('zone1', 'zone2')), zone_total(('zone4', 'zone5'))
    return {'workout': current, 'pte': (cloud.get('summary') or {}).get('pte'),
            'feeling': (cloud.get('summary') or {}).get('feeling'),
            'split_pattern': split_pattern(analysis),
            'intensity': {'classified_seconds': classified, 'easy_seconds': easy, 'high_seconds': high},
            'week': {'from': monday.isoformat(), 'to': sunday.isoformat(), 'group': current['group'],
                     'sessions': rows, 'comparable': comparable, 'totals': totals,
                     'ranks': ranks, 'other': other,
                     'load_share_percent': 100 * current['hr_tss'] / totals['hr_tss']
                     if number(current['hr_tss']) and totals['hr_tss'] and totals['hr_tss_count'] == len(comparable)
                     else None,
                     'coverage': 'Available records for this calendar week; totals may be incomplete. '
                                 'Running and walking are counted separately. '
                                 'Pace and heart rate reflect differences in terrain and session structure.'}}
