"""Match observed sleep to a workout without using future nights in its baseline."""

from datetime import datetime, timedelta
from statistics import mean, median
from zoneinfo import ZoneInfo

from suunto_cloud.analysis.metrics import number


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result if result.utcoffset() is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def metric(data, field, positive=False):
    value = data.get(field)
    return value if number(value) and (value > 0 if positive else value >= 0) else None


def sleep_records(payload, zone):
    """Prefer complete snapshots per SleepId; retain missing metrics as missing."""
    records = {}
    for sample in payload['data']:
        data = sample.get('entryData') or {}
        if not isinstance(data, dict) or data.get('IsNap') is True:
            continue
        start = timestamp(data.get('BedtimeStart'))
        end = timestamp(data.get('BedtimeEnd'))
        if start is None or end is None or end <= start:
            continue
        hrv = metric(data, 'AvgHRV', positive=True)
        count = metric(data, 'AvgHRVSampleCount', positive=True)
        if data.get('AvgHRVSampleCount') is not None and count is None:
            hrv = None
        stages = [metric(data, field) for field in
                  ('DeepSleepDuration', 'LightSleepDuration', 'REMSleepDuration')]
        stage_total = sum(stages) if all(v is not None for v in stages) else None
        duration = stage_total if stage_total else metric(data, 'Duration', positive=True)
        record = {'sleep_id': data.get('SleepId'), 'start': start.astimezone(zone).isoformat(),
                  'end': end.astimezone(zone).isoformat(), 'wake_date': end.astimezone(zone).date().isoformat(),
                  'sleep_seconds': duration, 'duration_method': 'sum_of_sleep_stages' if stage_total else 'Suunto Duration',
                  'quality_score': metric(data, 'SleepQualityScore'),
                  'hr_avg_bpm': metric(data, 'HRAvg', positive=True),
                  'hr_min_bpm': metric(data, 'HRMin', positive=True),
                  'hrv_ms': hrv, 'hrv_sample_count': count}
        identity = str(data['SleepId']) if data.get('SleepId') is not None else (start, end)
        score = (sum(record[field] is not None for field in
                     ('sleep_seconds', 'quality_score', 'hr_avg_bpm', 'hr_min_bpm', 'hrv_ms')),
                 count or 0, end)
        if identity not in records or score >= records[identity][0]:
            records[identity] = (score, record)
    return sorted((record for _, record in records.values()), key=lambda row: timestamp(row['end']))


def percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    index = int(position)
    remainder = position - index
    return ordered[index] + remainder * (ordered[min(index + 1, len(ordered) - 1)] - ordered[index])


def recovery_context(cloud, payload):
    if payload is None:
        return None
    start, stop = timestamp(cloud['start_local']), timestamp(cloud.get('stop_local'))
    name = cloud.get('timezone')
    zone = ZoneInfo(name) if name and name != 'system local' else None
    records = sleep_records(payload, zone)
    completed = [row for row in records if timestamp(row['end']) <= start]
    recent = [row for row in completed if start - timestamp(row['end']) <= timedelta(hours=24)]
    before = recent[-1] if recent else None
    anchor = timestamp(before['end']).astimezone(zone).date() if before else start.astimezone(zone).date()
    # One main sleep per local wake date. Split/duplicate uploads do not overweight a day.
    by_day = {}
    for row in completed:
        day = timestamp(row['end']).astimezone(zone).date()
        if day not in by_day or (row['sleep_seconds'] or 0) >= (by_day[day]['sleep_seconds'] or 0):
            by_day[day] = row
    last_week = [row['hrv_ms'] for day, row in by_day.items()
                 if anchor - timedelta(days=6) <= day <= anchor and row['hrv_ms'] is not None]
    history = [row['hrv_ms'] for day, row in by_day.items()
               if anchor - timedelta(days=60) <= day < anchor and row['hrv_ms'] is not None]
    reference = None
    if len(history) >= 14:
        reference = {'median_ms': median(history), 'low_ms': percentile(history, 0.1),
                     'high_ms': percentile(history, 0.9), 'night_count': len(history),
                     'method': 'Own descriptive reference: median and 10th–90th percentiles of '
                               'one main sleep per wake date in the preceding 60 calendar days; '
                               'excludes the selected night. Not the Suunto normal range or readiness status.'}
    after = next((row for row in records if stop is not None and
                  stop <= timestamp(row['start']) <= stop + timedelta(hours=24)), None)
    delta = (after['hrv_ms'] - before['hrv_ms'] if after and before and
             after['hrv_ms'] is not None and before['hrv_ms'] is not None else None)
    return {'source': payload.get('source', 'suunto_247_import'),
            'retrieved_at_utc': payload.get('retrieved_at_utc'),
            'before': before, 'after': after,
            'hrv_7d': {'average_ms': mean(last_week) if len(last_week) >= 3 else None,
                       'night_count': len(last_week), 'minimum_nights': 3,
                       'window_end': anchor.isoformat()},
            'reference_60d': reference, 'reference_night_count': len(history),
            'after_hrv_change_ms': delta,
            'method': 'Last completed non-nap sleep within 24 h before the workout. '
                      'Seven-day mean uses available nights, minimum three; no missing nights are imputed. '
                      'All pre-workout statistics exclude sleep ending after workout start. '
                      'After-workout sleep is separate and does not establish the cause of HRV changes. '
                      'Nighttime HR is not daytime resting HR.'}
