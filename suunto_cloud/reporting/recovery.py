"""Compact, descriptive recovery context shared by saved reports and chart headers."""

from datetime import datetime
from html import escape

from suunto_cloud.analysis.metrics import number
from suunto_cloud.reporting.recovery_charts import STATUS_COLORS, recovery_charts


def value(number, unit='', digits=0):
    return '—' if number is None else f'{number:.{digits}f}{unit}'


def sleep_time(seconds):
    if seconds is None:
        return '—'
    minutes = round(seconds / 60)
    return f'{minutes // 60} h {minutes % 60:02d} min'


def night_label(night):
    start, end = (datetime.fromisoformat(night[key]) for key in ('start', 'end'))
    return f'{start:%Y-%m-%d %H:%M} – {end:%Y-%m-%d %H:%M}'


def workout_feeling(raw):
    if not number(raw) or raw != int(raw) or not 1 <= raw <= 5:
        return {'rating': None, 'status': 'unknown', 'label': 'No rating'}
    status, label = ('green', 'High rating') if raw >= 4 else ('yellow', 'Neutral rating') if raw == 3 else ('red', 'Low rating')
    return {'rating': int(raw), 'status': status, 'label': label}


def tiles_svg(cards):
    out = []
    width = min(207, (1075 - 10 * (len(cards) - 1)) / len(cards))
    for index, (label, main, detail, status, custom_label) in enumerate(cards):
        x = 85 + index * (width + 10)
        background, foreground, border, status_label = STATUS_COLORS[status]
        status_label = custom_label or status_label
        out.extend([f'<g data-tile="{index}" data-status="{status}">',
                    f'<title>{escape(label)}: {status_label}</title>',
                    f'<rect x="{x:.2f}" y="151" width="{width:.2f}" height="112" rx="8" fill="{background}" stroke="{border}"/>',
                    f'<text x="{x+12:.2f}" y="174" font-size="13" fill="#526170">{escape(label)}</text>',
                    f'<text x="{x+12:.2f}" y="205" font-size="22" font-weight="bold">{escape(main)}</text>',
                    f'<text x="{x+12:.2f}" y="228" font-size="12" fill="#526170">{escape(detail)}</text>',
                    f'<text x="{x+12:.2f}" y="250" font-size="12" font-weight="bold" fill="{foreground}">{status_label}</text>',
                    '</g>'])
    return out


def recovery_svg(context, feeling=None):
    rating = workout_feeling(feeling)
    feeling_card = ('Workout feeling', f"{rating['rating']}/5" if rating['rating'] is not None else '—',
                    'Recorded after workout' if rating['rating'] is not None else 'Not recorded in Suunto',
                    rating['status'], rating['label'])
    if context is None and rating['rating'] is None:
        return [], 0
    night = context['before'] if context else None
    if night is None:
        caption = ('No completed sleep within 24 h before workout start.' if context is not None
                   else 'Subjective rating recorded in Suunto after the workout.')
        out = ['<g data-section="pre-workout-recovery">',
               '<text x="85" y="109" font-size="20" font-weight="bold">Recovery &amp; workout feeling</text>',
               f'<text x="85" y="135" font-size="15" fill="#526170">{caption}</text>']
        out.extend(tiles_svg([feeling_card]))
        out.extend(['<text x="85" y="286" font-size="13" fill="#526170">'
                    'Feeling colors: 4–5 green, 3 yellow, 1–2 red; missing ratings stay gray.</text>', '</g>'])
        return out, 264
    week, reference = context['hrv_7d'], context['reference_60d']
    statuses = context.get('statuses') or {}
    cards = [
        ('Nightly HRV', value(night['hrv_ms'], ' ms'),
         f"{value(night['hrv_sample_count'])} samples", statuses.get('hrv_ms', 'unknown'), None),
        ('7-day average HRV', value(week['average_ms'], ' ms', 1),
         f"{week['night_count']}/7 nights · calculated", statuses.get('hrv_7d', 'unknown'), None),
        ('60-day HRV reference',
         f"{value(reference['low_ms'])}–{value(reference['high_ms'])} ms" if reference else 'No reference',
         f"median {value(reference['median_ms'])} ms · {reference['night_count']} nights" if reference
         else f"{context['reference_night_count']}/14 required nights", 'reference', None),
        ('Sleep before workout', sleep_time(night['sleep_seconds']),
         f"quality {value(night['quality_score'])}/100", statuses.get('sleep', 'unknown'), None),
        ('Average overnight HR', value(night['hr_avg_bpm'], ' bpm'),
         f"minimum {value(night['hr_min_bpm'])} bpm", statuses.get('hr_avg_bpm', 'unknown'), None),
        feeling_card,
    ]
    out = ['<g data-section="pre-workout-recovery">',
           '<text x="85" y="109" font-size="20" font-weight="bold">Recovery &amp; workout feeling</text>',
           f'<text x="85" y="135" font-size="15" fill="#526170">Sleep: {escape(night_label(night))}</text>']
    out.extend(tiles_svg(cards))
    note = ('Calculated reference: central 80% of the preceding 60 days; '
            'selected night excluded. Not the Suunto normal range.' if reference else
            'Insufficient history for a reference. The 7-day average requires at least 3 nights.')
    out.extend(['<text x="85" y="286" font-size="13" fill="#526170">'
                'History colors: green = within reference; yellow = outside; red = large deviation. Feeling: 4–5 green, 3 yellow, 1–2 red.</text>',
                f'<text x="85" y="307" font-size="13" fill="#526170">{escape(note)}</text>',
                '</g>'])
    trends, offset = recovery_charts(context)
    out.extend(trends)
    return out, offset


def recovery_markdown(context):
    if context is None:
        return []
    night = context['before']
    lines = ['', '## Pre-workout recovery', '']
    if night is None:
        lines.append('No completed sleep within 24 h before workout start; older nights were not substituted.')
    else:
        week, reference = context['hrv_7d'], context['reference_60d']
        lines.extend([f"Sleep: {night_label(night)}.", '', '| Metric | Value |', '| --- | --- |',
                      f"| Nightly HRV | {value(night['hrv_ms'], ' ms')}; samples: {value(night['hrv_sample_count'])} |",
                      f"| 7-day average HRV | {value(week['average_ms'], ' ms', 1)}; {week['night_count']}/7 nights |",
                      f"| Sleep | {sleep_time(night['sleep_seconds'])}; quality {value(night['quality_score'])}/100 |",
                      f"| Average / minimum overnight HR | {value(night['hr_avg_bpm'])} / {value(night['hr_min_bpm'])} bpm |"])
        if reference:
            lines.append(f"| Calculated 60-day HRV reference | {value(reference['low_ms'])}–{value(reference['high_ms'])} ms; "
                         f"median {value(reference['median_ms'])} ms; {reference['night_count']} nights |")
            lines.extend(['', reference['method']])
        else:
            lines.extend(['', f"No calculated reference: {context['reference_night_count']}/14 required nights."])
        if week['average_ms'] is None:
            lines.extend(['', 'The 7-day average requires at least 3 nights with HRV.'])
    after = context.get('after')
    if after:
        lines.extend(['', '## Night after workout', '', f"Sleep: {night_label(after)}.", '',
                      f"HRV {value(after['hrv_ms'], ' ms')}; sleep {sleep_time(after['sleep_seconds'])}; "
                      f"quality {value(after['quality_score'])}/100; average overnight HR {value(after['hr_avg_bpm'], ' bpm')}."])
        delta = context.get('after_hrv_change_ms')
        if delta is not None:
            lines.append(f'HRV change from the pre-workout night: {delta:+.0f} ms. '
                         'This change alone does not establish the effect of this session.')
    lines.extend(['', f"Sleep source: {context['source']}; retrieved: {context.get('retrieved_at_utc') or 'not provided'}.",
                  context['method']])
    if context.get('color_method'):
        labels = {key: item[3] for key, item in STATUS_COLORS.items()}
        statuses = context.get('statuses') or {}
        lines.extend(['', '### Historical comparison', '', '| Metric | Status |', '| --- | --- |'])
        for field, name in (('hrv_ms', 'Nightly HRV'), ('hrv_7d', '7-day average HRV'),
                            ('sleep_seconds', 'Sleep duration'), ('quality_score', 'Sleep quality'),
                            ('hr_avg_bpm', 'Average overnight HR')):
            lines.append(f"| {name} | {labels[statuses.get(field, 'unknown')]} |")
        lines.extend(['', context['color_method']])
    return lines
