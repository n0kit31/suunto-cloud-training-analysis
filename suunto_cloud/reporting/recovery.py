"""Compact, descriptive recovery context shared by saved reports and chart headers."""

from datetime import datetime
from html import escape


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


def recovery_svg(context):
    if context is None:
        return [], 0
    night = context['before']
    if night is None:
        return ['<g data-section="pre-workout-recovery">',
                '<text x="85" y="108" font-size="19">Pre-workout recovery</text>',
                '<text x="85" y="136" font-size="16" fill="#526170">No completed sleep within 24 h before workout start.</text>',
                '</g>'], 80
    week, reference = context['hrv_7d'], context['reference_60d']
    cards = [
        ('Nightly HRV', value(night['hrv_ms'], ' ms'),
         f"{value(night['hrv_sample_count'])} samples"),
        ('7-day average HRV', value(week['average_ms'], ' ms', 1),
         f"{week['night_count']}/7 nights · calculated"),
        ('60-day HRV reference',
         f"{value(reference['low_ms'])}–{value(reference['high_ms'])} ms" if reference else 'No reference',
         f"median {value(reference['median_ms'])} ms · {reference['night_count']} nights" if reference
         else f"{context['reference_night_count']}/14 required nights"),
        ('Sleep before workout', sleep_time(night['sleep_seconds']),
         f"quality {value(night['quality_score'])}/100"),
        ('Average overnight HR', value(night['hr_avg_bpm'], ' bpm'),
         f"minimum {value(night['hr_min_bpm'])} bpm"),
    ]
    out = ['<g data-section="pre-workout-recovery">',
           '<text x="85" y="109" font-size="20" font-weight="bold">Pre-workout recovery</text>',
           f'<text x="85" y="135" font-size="15" fill="#526170">Sleep: {escape(night_label(night))}</text>']
    for index, (label, main, detail) in enumerate(cards):
        x = 85 + index * 217
        out.extend([f'<rect x="{x}" y="151" width="207" height="91" rx="8" fill="#f3f6f8"/>',
                    f'<text x="{x+12}" y="174" font-size="13" fill="#526170">{escape(label)}</text>',
                    f'<text x="{x+12}" y="205" font-size="22" font-weight="bold">{escape(main)}</text>',
                    f'<text x="{x+12}" y="228" font-size="12" fill="#526170">{escape(detail)}</text>'])
    note = ('Calculated reference: central 80% of the preceding 60 days; '
            'selected night excluded. Not the Suunto normal range.' if reference else
            'Insufficient history for a reference. The 7-day average requires at least 3 nights.')
    out.extend([f'<text x="85" y="266" font-size="13" fill="#526170">{escape(note)}</text>',
                '<text x="85" y="287" font-size="13" fill="#526170">'
                'Pre-workout context: interpret alongside how you feel and how the workout went.</text>',
                '</g>'])
    return out, 240


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
    return lines
