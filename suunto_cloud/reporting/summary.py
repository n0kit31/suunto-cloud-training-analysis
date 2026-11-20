"""Concise English workout narrative and weekly comparison for the chart page."""

from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from html import escape
import math

from suunto_cloud.analysis.metrics import number
from suunto_cloud.reporting.recovery import value
from suunto_cloud.reporting.workout_tiles import recovery_labels


def clock(value):
    if not number(value):
        return '—'
    seconds = math.floor(value + .5)
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f'{hours}:{minutes:02}:{seconds:02}' if hours else f'{minutes}:{seconds:02}'


def pace(value):
    return clock(value) + '/km' if number(value) else '—'


def amount(value, digits=1):
    if not number(value):
        return '—'
    rounded = Decimal(str(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return f'{rounded:.{digits}f}'


def summary_html(context):
    if not context:
        return ''
    row, week = context['workout'], context['week']
    km = row['distance_m'] / 1000 if number(row['distance_m']) else None
    facts = [f"{amount(km, 2)} km in {clock(row['active_seconds'])} of active time "
             f"({pace(row['pace_seconds_per_km'])}), with average / maximum heart rate "
             f"{amount(row['avg_hr_bpm'], 0)} / {amount(row['max_hr_bpm'], 0)} bpm."]
    metrics = []
    if number(row['ascent_m']):
        metrics.append(f"{amount(row['ascent_m'], 0)} m ascent")
    if number(row['hr_tss']):
        metrics.append(f"HR-TSS {amount(row['hr_tss'])}")
    if number(context['pte']):
        metrics.append(f"PTE {amount(context['pte'])}")
    if metrics:
        facts.append('; '.join(metrics) + '.')
    pattern = context['split_pattern']
    if pattern:
        fast, slow = pattern['fast_pace_range'], pattern['slower_pace_range']
        facts.append(f"The kilometre splits show {pattern['count']} faster 1 km segments "
                     f"at {clock(fast[0])}–{pace(fast[1])}, alternating with slower kilometres "
                     f"at {clock(slow[0])}–{pace(slow[1])}. Terrain may influence these pace differences.")
    else:
        intensity = context['intensity']
        classified = intensity['classified_seconds']
        if classified and intensity['easy_seconds'] / classified >= .9:
            facts.append('Most classified heart-rate time was in zones 1–2.')
        elif classified and intensity['high_seconds'] / classified >= .2:
            facts.append(f"Recorded time in heart-rate zones 4–5 was {clock(intensity['high_seconds'])}.")
    if number(context['feeling']) and context['feeling'] in (1, 2, 3, 4, 5):
        facts.append(f"Recorded workout feeling: {amount(context['feeling'], 0)}/5.")
    highlights = context.get('highlights') or {}
    if number(highlights.get('temperature_c')):
        facts.append(f"Average workout temperature: {value(highlights['temperature_c'], ' °C', 1)} (watch sensor).")
    if highlights.get('recovery_seconds') is not None:
        estimate, kind, until = recovery_labels(highlights)
        deadline = f' · {until}' if until else ''
        facts.append(f'Suunto recovery time: {estimate} ({kind.lower()}){deadline}.')

    comparisons = []
    ranks = week['ranks']
    if ranks['distance_m']:
        comparisons.append('was the longest session' if ranks['distance_m'] == 'highest' else 'was joint longest by distance')
    if ranks['hr_tss']:
        comparisons.append('had the highest HR-TSS' if ranks['hr_tss'] == 'highest' else 'had joint highest HR-TSS')
    count = len(week['comparable'])
    comparison = ('This workout ' + ' and '.join(comparisons)
                  + f" among {count} available {week['group'].lower()} sessions.") if comparisons else (
        'No other comparable session is available for this week.' if count < 2
        else f"Compared with the other {week['group'].lower()} sessions recorded this week:")
    if number(week['load_share_percent']) and count > 1:
        comparison += f" It contributed {week['load_share_percent']:.0f}% of their combined HR-TSS."

    rows = []
    for peer in week['comparable']:
        selected = peer['workout_key'] == row['workout_key'] and peer['start_local'] == row['start_local']
        day = datetime.fromisoformat(peer['start_local']).strftime('%a %d %b')
        values = [day, peer['activity'], amount(peer['distance_m'] / 1000, 2) if number(peer['distance_m']) else '—',
                  clock(peer['active_seconds']), pace(peer['pace_seconds_per_km']),
                  amount(peer['avg_hr_bpm'], 0), amount(peer['hr_tss'])]
        cells = ''.join(f'<td>{escape(value)}</td>' for value in values)
        rows.append(f'<tr class="{"selected-workout" if selected else ""}">{cells}</tr>')
    totals = week['totals']
    total_km = totals['distance_m'] / 1000 if number(totals['distance_m']) else None
    total_load = amount(totals['hr_tss'])
    if totals['hr_tss_count'] != count:
        total_load += f" ({totals['hr_tss_count']}/{count} sessions)"
    other = ' '.join(f"{group['group']}: {group['count']} sessions"
                     + (f", {group['distance_m'] / 1000:.2f} km." if number(group['distance_m']) else '.')
                     for group in week['other'])
    paragraphs = ''.join(f'<p>{escape(text)}</p>' for text in facts)
    return f'''<section class="workout-summary" aria-label="Workout summary and weekly comparison">
<article><h2>Workout summary</h2>{paragraphs}</article>
<article><h2>This week <span>{escape(week['from'])} – {escape(week['to'])}</span></h2>
<p>{escape(comparison)}</p>
<div class="week-totals">
<div><strong>{amount(total_km, 2)} km</strong><span>{escape(week['group'])} · {count} sessions</span></div>
<div><strong>{clock(totals['active_seconds'])}</strong><span>Active time</span></div>
<div><strong>{escape(total_load)}</strong><span>HR-TSS</span></div>
</div>
<div class="week-table"><table><thead><tr><th>Date</th><th>Activity</th><th>km</th><th>Active</th>
<th>Pace</th><th>Avg HR</th><th>HR-TSS</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
{f'<p class="other-activity">Other activity: {escape(other)}</p>' if other else ''}
<p class="comparison-note">{escape(week['coverage'])}</p>
</article></section>'''
