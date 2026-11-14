"""Calendar-based HRV and sleep panels, separate from the workout's time axis."""

from datetime import date, timedelta
from html import escape
import math

from suunto_cloud.analysis.sleep import deviation_status


STATUS_COLORS = {
    'green': ('#e8f5eb', '#226b3c', '#c5e2cd', 'Within reference'),
    'yellow': ('#fff4d2', '#886000', '#edd489', 'Outside reference'),
    'red': ('#fde8e8', '#a22e36', '#efbec2', 'Large deviation'),
    'unknown': ('#f3f6f8', '#526170', '#dce2e7', 'No comparison'),
    'reference': ('#f3f6f8', '#526170', '#dce2e7', 'Reference only'),
}
STAGES = [('deep', 'Deep', '#4b57a9'), ('light', 'Light', '#8d9ce8'), ('rem', 'REM', '#bd75c4')]


def slots(context):
    result = [dict(row, after=False) for row in context.get('nights_7d', [])]
    after = context.get('after')
    if result and after:
        last = date.fromisoformat(result[-1]['wake_date'])
        end = date.fromisoformat(after['wake_date'])
        # An unusually long/malformed sleep must not create an unbounded calendar axis.
        if 0 < (end - last).days <= 3:
            while last < end:
                last += timedelta(days=1)
                result.append({'wake_date': last.isoformat(), 'sleep': after if last == end else None,
                               'after': last == end})
    return result


def recovery_charts(context):
    nights = slots(context)
    if not nights:
        return [], 264
    left, right, width = 85, 1160, 1075
    pitch = width / len(nights)
    x = lambda index: left + (index + 0.5) * pitch
    selected = context['before']['wake_date']
    ref = (context.get('references') or {}).get('hrv_ms')
    average = context['hrv_7d']['average_ms']
    observed = [row['sleep']['hrv_ms'] for row in nights
                if row['sleep'] and row['sleep']['hrv_ms'] is not None]
    values = observed + ([average] if average is not None else [])
    if ref:
        values += [ref['low'], ref['high']]
    out = ['<g data-section="hrv-history">',
           '<text x="85" y="346" font-size="19">Nightly HRV · last 7 nights</text>']
    legend = []
    if ref:
        legend += ['<rect x="85" y="361" width="14" height="12" fill="#d9eddf"/>',
                   '<text x="106" y="372" font-size="13">60-day reference</text>']
    if average is not None:
        legend += ['<line x1="330" x2="353" y1="367" y2="367" stroke="#33718f" stroke-dasharray="5 3"/>',
                   f'<text x="360" y="372" font-size="13">7-day mean: {average:.1f} ms</text>']
    legend += ['<circle cx="691" cy="367" r="5" fill="#17212b"/>',
               '<text x="704" y="372" font-size="13">Before workout</text>']
    if any(row['after'] for row in nights):
        legend += ['<circle cx="935" cy="367" r="5" fill="white" stroke="#788795" stroke-width="2"/>',
                   '<text x="948" y="372" font-size="13">After workout</text>']
    out.extend(legend)
    top, ph = 395, 155
    if values:
        padding = max(5, (max(values) - min(values)) * 0.15)
        low = max(0, math.floor((min(values) - padding) / 10) * 10)
        high = max(low + 10, math.ceil((max(values) + padding) / 10) * 10)
        y = lambda value: top + (high - value) / (high - low) * ph
        if ref:
            out.append(f'<rect data-role="hrv-reference-band" x="{left}" y="{y(ref["high"]):.2f}" '
                       f'width="{width}" height="{y(ref["low"])-y(ref["high"]):.2f}" fill="#d9eddf"/>')
        for tick in range(5):
            value = low + tick * (high - low) / 4
            out += [f'<line x1="{left}" x2="{right}" y1="{y(value):.2f}" y2="{y(value):.2f}" stroke="#dce1e6"/>',
                    f'<text x="73" y="{y(value)+5:.2f}" font-size="14" text-anchor="end">{value:g}</text>']
        out.append('<text x="45" y="388" font-size="13">ms</text>')
        if average is not None:
            out.append(f'<line data-role="hrv-7d-mean" x1="{left}" x2="{right}" '
                       f'y1="{y(average):.2f}" y2="{y(average):.2f}" stroke="#33718f" stroke-dasharray="6 4"/>')
        previous = None
        for index, row in enumerate(nights):
            night = row['sleep']
            value = night['hrv_ms'] if night else None
            if value is None or row['after']:
                previous = None
            if value is None:
                continue
            if previous is not None:
                px, py = previous
                out.append(f'<line data-role="hrv-daily-line" x1="{px:.2f}" y1="{py:.2f}" x2="{x(index):.2f}" '
                           f'y2="{y(value):.2f}" stroke="#738796" stroke-width="1.8"/>')
            if not row['after']:
                previous = (x(index), y(value))
        for index, row in enumerate(nights):
            night = row['sleep']
            value = night['hrv_ms'] if night else None
            if value is None:
                continue
            is_selected = row['wake_date'] == selected and not row['after']
            status = deviation_status(value, ref)
            color = '#788795' if row['after'] else STATUS_COLORS[status][1]
            role = 'after-workout' if row['after'] else 'selected-night' if is_selected else 'night'
            fill = 'white' if row['after'] else color
            stroke = '#17212b' if is_selected else color
            radius = 7 if is_selected else 5
            out.append(f'<circle data-role="{role}" data-value="{value}" cx="{x(index):.2f}" '
                       f'cy="{y(value):.2f}" r="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="2">'
                       f'<title>{row["wake_date"]}: {value:g} ms</title></circle>')
            if is_selected or row['after']:
                label = f'After: {value:g}' if row['after'] else f'{value:g}'
                out.append(f'<text x="{x(index):.2f}" y="{y(value)-15:.2f}" font-size="14" '
                           f'text-anchor="middle" font-weight="bold" fill="{color}">{label}</text>')
    else:
        out.append('<text x="85" y="460" font-size="16" fill="#526170">No nightly HRV samples in this window.</text>')
    for index, row in enumerate(nights):
        weight = 'bold' if row['wake_date'] == selected and not row['after'] else 'normal'
        out.append(f'<text x="{x(index):.2f}" y="574" font-size="14" text-anchor="middle" '
                   f'font-weight="{weight}">{row["wake_date"][5:]}</text>')
        if row['after']:
            divider = left + index * pitch
            out.append(f'<line data-role="after-workout-divider" x1="{divider:.2f}" x2="{divider:.2f}" '
                       'y1="390" y2="550" stroke="#a2adb7" stroke-dasharray="4 4"/>')
    out += ['<text x="622.5" y="598" font-size="14" text-anchor="middle">Wake date · workout local time</text>',
            '<text x="85" y="620" font-size="13" fill="#526170">After-workout values are separate; '
            'they do not enter the pre-workout average or reference. Missing nights remain gaps.</text>', '</g>',
            '<g data-section="sleep-history">',
            '<text x="85" y="656" font-size="19">Sleep stages · same nights</text>']
    for index, (_, label, color) in enumerate(STAGES + [('unknown', 'Stage breakdown unavailable', '#cad2da')]):
        lx = 85 + index * 185
        out += [f'<rect x="{lx}" y="673" width="14" height="12" fill="{color}"/>',
                f'<text x="{lx+21}" y="685" font-size="13">{escape(label)}</text>']
    top, ph = 710, 150
    durations = [row['sleep']['sleep_seconds'] / 3600 for row in nights
                 if row['sleep'] and row['sleep']['sleep_seconds'] is not None]
    high = max(2, math.ceil(max(durations, default=0) / 2) * 2)
    y = lambda hours: top + ph - hours / high * ph
    for tick in range(5):
        hours = tick * high / 4
        out += [f'<line x1="{left}" x2="{right}" y1="{y(hours):.2f}" y2="{y(hours):.2f}" stroke="#dce1e6"/>',
                f'<text x="73" y="{y(hours)+5:.2f}" font-size="14" text-anchor="end">{hours:g}</text>']
    out.append('<text x="40" y="702" font-size="13">hours</text>')
    bar_width = min(64, pitch * 0.55)
    for index, row in enumerate(nights):
        night = row['sleep']
        duration = night['sleep_seconds'] if night else None
        is_selected = row['wake_date'] == selected and not row['after']
        if duration is not None:
            stages = night.get('stages_seconds') or {}
            complete = all(stages.get(key) is not None for key, _, _ in STAGES) and sum(stages.values()) > 0
            groups = [(key, stages[key], color) for key, _, color in STAGES] if complete else [('unknown', duration, '#cad2da')]
            total = 0
            for key, seconds, color in groups:
                hours = seconds / 3600
                total += hours
                out.append(f'<rect data-stage="{key}" data-wake-date="{row["wake_date"]}" '
                           f'x="{x(index)-bar_width/2:.2f}" y="{y(total):.2f}" width="{bar_width:.2f}" '
                           f'height="{hours/high*ph:.2f}" fill="{color}" opacity="{0.5 if row["after"] else 1}">'
                           f'<title>{row["wake_date"]}: {key}, {seconds/60:g} min</title></rect>')
            if is_selected:
                out.append(f'<rect data-role="selected-sleep" x="{x(index)-bar_width/2:.2f}" y="{y(total):.2f}" '
                           f'width="{bar_width:.2f}" height="{total/high*ph:.2f}" fill="none" stroke="#17212b" stroke-width="2"/>')
            minutes = round(duration / 60)
            quality = f'{night["quality_score"]:g}' if night['quality_score'] is not None else '—'
            label = f'{minutes//60}:{minutes%60:02d} · {quality}'
        else:
            label = 'No data'
        out.append(f'<text x="{x(index):.2f}" y="884" font-size="14" text-anchor="middle" '
                   f'font-weight="{"bold" if is_selected else "normal"}">{row["wake_date"][5:]}</text>')
        out.append(f'<text x="{x(index):.2f}" y="906" font-size="12" text-anchor="middle" fill="#526170">{label}</text>')
        if row['after']:
            divider = left + index * pitch
            out.append(f'<line x1="{divider:.2f}" x2="{divider:.2f}" y1="705" y2="860" '
                       'stroke="#a2adb7" stroke-dasharray="4 4"/>')
    out += ['<text x="622.5" y="932" font-size="14" text-anchor="middle">'
            'Wake date · labels: sleep h:mm · quality /100</text>', '</g>']
    return out, 900
