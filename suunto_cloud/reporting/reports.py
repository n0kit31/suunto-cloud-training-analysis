"""Generate reusable factual reports and portable SVG charts in the sync process."""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from html import escape
import math
from pathlib import Path
from statistics import median, mean

from suunto_cloud.storage.local import private_json
from suunto_cloud.analysis.metrics import active_samples, number, seconds

START = '<!-- suunto-generated:start -->'
END = '<!-- suunto-generated:end -->'
CHART_MARKER = '<!-- generated: suunto-analysis -->'


def duration(value):
    if not number(value):
        return '—'
    value = round(value, 1)
    return f'{int(value // 60)}:{value % 60:04.1f}'


def display(value, digits=1):
    return '—' if value is None else f'{value:.{digits}f}' if number(value) else str(value)


def pace_from_speed(speed):
    return 1000 / (60 * speed) if number(speed) and speed > 0 else None


def pace_series(rows, origin):
    bins = defaultdict(list)
    for when, row in rows:
        pace = pace_from_speed(row.get('speed'))
        if pace is not None:
            elapsed = when - origin
            bins[int(elapsed // 10)].append((elapsed, pace))
    return [(mean(t for t, _ in values), median(v for _, v in values))
            for _, values in sorted(bins.items()) if len(values) >= 3]


def segments(points, gap):
    result, current = [], []
    for point in points:
        if current and point[0] - current[-1][0] > gap:
            result.append(current)
            current = []
        current.append(point)
    if current:
        result.append(current)
    return result


def moving_average(points, window=15, gap=2):
    """Centered sample mean in a time window, separately for each observed segment."""
    result = []
    for group in segments(points, gap):
        times = [t for t, _ in group]
        sums = [0]
        for _, value in group:
            sums.append(sums[-1] + value)
        for when, _ in group:
            first = bisect_left(times, when - window / 2)
            last = bisect_right(times, when + window / 2)
            result.append((when, (sums[last] - sums[first]) / (last - first)))
    return result


def moving_median(points, window=15, gap=2):
    """Centered median within each continuous measurement segment."""
    result = []
    for group in segments(points, gap):
        times = [t for t, _ in group]
        for when, _ in group:
            first = bisect_left(times, when - window / 2)
            last = bisect_right(times, when + window / 2)
            result.append((when, median(value for _, value in group[first:last])))
    return result


def doubled_range(groups, minimum_span, nonnegative=False):
    """Double the plotted min-max span around its midpoint."""
    values = [value for group in groups for _, value in group]
    low, high = min(values), max(values)
    middle = (low + high) / 2
    span = max(high - low, minimum_span)
    low = middle - span
    if nonnegative:
        low = max(0, low)
    return low, low + 2 * span


def thin(points, limit):
    """Preserve chronological bucket extrema instead of smoothing the signal."""
    if len(points) <= limit:
        return points
    width = max(1, math.ceil(len(points) / max(1, limit // 4)))
    indices = set()
    for start in range(0, len(points), width):
        stop = min(start + width, len(points))
        candidates = range(start, stop)
        indices.update((start, stop - 1, min(candidates, key=lambda i: points[i][1]),
                        max(candidates, key=lambda i: points[i][1])))
    return [points[i] for i in sorted(indices)]


def chart_svg(data, analysis, cloud, hr_range=None):
    rows = active_samples(data, analysis['timer'])
    if not rows:
        return None
    intervals = [(seconds(s['start']), seconds(s['end'])) for s in analysis['timer']['active_segments']]

    def active_time(when):
        return sum(max(0, min(when, end) - start) for start, end in intervals)

    total = max(1, sum(end - start for start, end in intervals))
    # Smooth on original timestamps so pauses and missing measurements separate windows.
    hr_observed = [(t, r['heart_rate']) for t, r in rows if number(r.get('heart_rate'))]
    hr_times = [t for t, _ in hr_observed]
    hr = []
    for start, end in intervals:
        observed = hr_observed[bisect_left(hr_times, start):bisect_left(hr_times, end)]
        hr.extend((active_time(t), value) for t, value in moving_average(observed))
    def smoothed_groups(field, smooth, transform=lambda value: value):
        observed = [(t, transform(r[field])) for t, r in rows if number(r.get(field))]
        observed = [(t, value) for t, value in observed if number(value)]
        times = [t for t, _ in observed]
        mapped = []
        for start, end in intervals:
            group = observed[bisect_left(times, start):bisect_left(times, end)]
            mapped.extend((active_time(t), value) for t, value in smooth(group))
        return segments(mapped, 2)

    altitude = smoothed_groups('altitude', moving_average)
    pace = smoothed_groups('speed', moving_median, pace_from_speed)
    panels = []
    if hr:
        lo, hi = hr_range if hr_range is not None else (65, 190)
        panels.append(('Heart rate (bpm) · 15 s moving average', [hr], lo, hi, '#b52f3c', False))
    if pace:
        lo, hi = doubled_range(pace, minimum_span=0.5, nonnegative=True)
        continuous_pace = [point for group in pace for point in group]
        panels.append(('Pace (min/km) · 15 s moving median', [continuous_pace], lo, hi, '#24679c', True))
    if altitude:
        lo, hi = doubled_range(altitude, minimum_span=1)
        panels.append(('Elevation (m above sea level) · 15 s moving average', altitude, lo, hi, '#27704d', False))
    if not panels:
        return None
    width, left, right, ph, spacing = 1200, 85, 40, 170, 250
    height = 130 + len(panels) * spacing
    pw = width - left - right
    x = lambda t: left + t / total * pw
    date = datetime.fromisoformat(cloud['start_local']).strftime('%Y-%m-%d %H:%M')
    lap_by_index = {i: lap for i, lap in enumerate(data.get('laps', []), 1)}
    work_laps = [lap_by_index[r['work_lap_index']]
                 for r in analysis['additional_metrics']['slower_next_lap_hr_changes']]
    subtitle = 'Time axis: active workout time'
    if work_laps:
        subtitle += ' · blue bands: interval before a slower workout step'
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
           f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">', CHART_MARKER,
           f'<title id="title">Workout overview {date}</title>',
           '<desc id="desc">Active workout time axis. '
           'Heart rate: centered 15 s moving average, with gaps connected linearly on the chart. '
           'Pace: centered 15 s moving median. Elevation: centered 15 s moving average. '
           'Smoothing resets at pauses and gaps over 2 s. Pace gaps are connected linearly on the chart only; '
           'elevation retains measurement gaps. '
           'Pace and elevation axes double the smoothed min-max span around its midpoint; '
           'pace is bounded below by zero. Minimum data spans: 0.5 min/km and 1 m. '
           'Colored areas extend from each line to the bottom of its panel.</desc>',
           f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
           '<g font-family="Arial, sans-serif" fill="#17212b">',
           f'<text x="85" y="35" font-size="25">Workout overview · {date}</text>',
           f'<text x="85" y="65" font-size="17">{subtitle}</text>']
    for index, (title, groups, lo, hi, color, inverted) in enumerate(panels):
        top = 130 + index * spacing
        y = lambda v: top + ((v - lo) if inverted else (hi - v)) / (hi - lo) * ph
        out.extend([f'<defs><clipPath id="panel-{index}"><rect x="{left}" y="{top}" '
                    f'width="{pw}" height="{ph}"/></clipPath></defs>',
                    f'<text x="{left}" y="{top - 25}" font-size="19">{escape(title)}</text>'])
        for lap in work_laps:
            x1, x2 = x(active_time(seconds(lap['start_time']))), x(active_time(seconds(lap['timestamp'])))
            out.append(f'<rect x="{x1:.2f}" y="{top}" width="{x2 - x1:.2f}" height="{ph}" fill="#e8f0f8"/>')
        for tick in range(6):
            v = lo + tick * (hi - lo) / 5
            label = duration(round(v * 60)).removesuffix('.0') if inverted else display(v, 0)
            out.extend([f'<line x1="{left}" y1="{y(v):.2f}" x2="{width-right}" y2="{y(v):.2f}" stroke="#dce1e6"/>',
                        f'<text x="{left-12}" y="{y(v)+5:.2f}" font-size="16" text-anchor="end">{label}</text>'])
        step = max(60, math.ceil(total / 600) * 60)
        for t in range(0, math.ceil(total) + 1, step):
            out.append(f'<text x="{x(t):.2f}" y="{top+ph+25}" font-size="16" text-anchor="middle">{t // 60}</text>')
        count = sum(len(g) for g in groups)
        for group in groups:
            points = thin(group, max(4, int(1600 * len(group) / max(1, count))))
            if len(points) < 2:
                continue
            coords = ' '.join(f'{x(t):.2f},{y(v):.2f}' for t, v in points)
            area = f'{x(points[0][0]):.2f},{top+ph} {coords} {x(points[-1][0]):.2f},{top+ph}'
            out.append(f'<polygon points="{area}" fill="{color}" fill-opacity="0.25" '
                       f'clip-path="url(#panel-{index})"/>')
            out.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="1.8" '
                       f'clip-path="url(#panel-{index})" stroke-linejoin="round"/>')
        out.append(f'<text x="{left+pw/2}" y="{top+ph+49}" font-size="16" text-anchor="middle">Active workout time (min)</text>')
    out.extend([f'<text x="85" y="{height-15}" font-size="15">HR: 15 s mean. Pace: 15 s median. '
                'Elevation: 15 s mean. Pace/elevation axes: doubled min-max span. HR/pace gaps connected.</text>', '</g></svg>'])
    return '\n'.join(out) + '\n'


def report_body(cloud, analysis, entry, retrieved, chart):
    summary, details = cloud['summary'], analysis['additional_metrics']
    zone = cloud.get('timezone') or datetime.fromisoformat(cloud['start_local']).tzname()
    lines = [f"Retrieved: {retrieved}; timezone {zone}; ID `{cloud['workout_key']}`.", '',
             '| Metric | Value |', '| --- | --- |',
             f"| Distance | {display(cloud['distance_m'] / 1000, 3)} km |",
             f"| Active / elapsed time | {duration(cloud['active_seconds'])} / {duration(cloud['elapsed_seconds'])} |",
             f"| Active pace | {duration(cloud['pace_seconds_per_km'])}/km |",
             f"| Average / maximum HR | {cloud['avg_hr_bpm']} / {cloud['max_hr_bpm']} |",
             f"| Ascent / descent | {display(cloud['ascent_m'])} / {display(cloud['descent_m'])} m |",
             f"| TSS | {display((cloud['tss'] or {}).get('trainingStressScore'), 3)}; {(cloud['tss'] or {}).get('calculationMethod')} |",
             f"| PTE / estimated VO₂max | {display(summary.get('pte'))} / {display((cloud['fitness'] or {}).get('estimatedVo2Max'))} |",
             '', '## Laps and running mechanics', '',
             'One non-overlapping lap type was selected. Pace uses active time and distance; mechanics use available paired samples.', '',
             '| Lap | m | Time | Pace/km | Avg/max HR | W | +m/−m | Steps/min | Contact ms | Oscillation cm | Estimated step m |',
             '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    by_index = {l['index']: l for l in analysis['laps']}
    for samples in details['lap_samples']:
        lap = by_index[samples['lap_index']]
        m = samples.get('mechanics', {})
        lines.append(f"| {lap['index']} | {lap['distance_m']} | {duration(lap['active_seconds'])} | "
                     f"{duration(lap['pace_seconds_per_km'])} | {lap['avg_hr']}/{lap['max_hr']} | "
                     f"{display(lap['avg_power_w'], 0)} | {display(lap['ascent_m'])}/{display(lap['descent_m'])} | "
                     f"{display(m.get('cadence_steps_per_min'))} | {display(m.get('ground_contact_ms'))} | "
                     f"{display(m.get('vertical_oscillation_cm'), 2)} | {display(m.get('estimated_step_length_m'), 3)} |")
    lines.extend(['', '## Pauses and HR after slowing down', ''])
    for pause in analysis['timer']['pauses']:
        lines.append(f"- {pause['start']}–{pause['end']}: {duration(pause['seconds'])}; reason unknown.")
    if not analysis['timer']['pauses']:
        lines.append('No pauses confirmed by timer events.')
    for recovery in details['slower_next_lap_hr_changes']:
        lines.append(f"- Lap {recovery['work_lap_index']} → {recovery['slower_next_lap_index']}: "
                     f"HR drop after 60 s: {display(recovery['hr_drop_after_60_seconds'], 0)} bpm; "
                     f"pause in the next step: {recovery['pause_in_next_lap']}. This is not a clinical HRR test.")
    lines.extend(['', '## Intensity and additional data', ''])
    hr_zones = ((cloud.get('intensity') or {}).get('zones') or {}).get('heartRate', {})
    for name, zone in hr_zones.items():
        value = zone.get('totalTime')
        if number(value):
            lines.append(f"- HR {name}: {duration(value)}; lower limit {display(zone.get('lowerLimit'), 0)} bpm.")
    zone_sense = (cloud.get('zone_sense') or {}).get('zones', {})
    if zone_sense:
        lines.append('- ZoneSense (separate classification; no percentages of active time): ' + '; '.join(
            f'{key}: {duration(value / 1000)}' for key, value in zone_sense.items()
            if key.endswith('Ms') and number(value)))
    for channel in details['suuntoplus_channels']:
        lines.append(f"- SuuntoPlus {channel['label']}: unit `{channel['unit']}`, "
                     f"{channel['active_sample_count']} active samples, last value "
                     f"{display(channel['last_active_value'], 3)}, session result {display(channel['session_value'], 3)}.")
    lines.extend(['', 'Marathon time estimators project a finish time from pace; they do not measure maximum performance. '
                  'Do not add TSS values calculated with different methods. Power thresholds, grade-adjusted pace units, '
                  'missing ZoneSense thresholds, and R-R artifacts require separate assessment before interpretation.', '',
                  details['method'], '', 'Full data, sample counts, and additional fields are in the adjacent JSON file; '
                  f"original FIT: `{entry['fit_path']}`, SHA-256 `{entry['fit_sha256']}`."])
    if chart:
        lines.extend(['', f'[Heart rate, pace, and elevation chart]({chart})'])
        lines.extend(['', 'HR chart: centered 15 s moving average of available samples (±7.5 s), '
                      'calculated separately for continuous measurement segments. Gaps >2 s and pauses separate windows. '
                      'Gaps in the heart rate line are connected linearly on the chart only. '
                      'HR values in tables and analysis come from source data.'])
        lines.extend(['', 'Pace chart: centered 15 s moving median. Elevation chart: centered 15 s moving average. '
                      'Both reset at pauses and measurement gaps >2 s. Pace gaps are connected linearly '
                      'on the chart only; elevation gaps remain visible. No source samples are added. '
                      'Their axes use twice the smoothed min-max span around its midpoint, '
                      'with minimum data spans of 0.5 min/km and 1 m. Pace bounds shift upward '
                      'if needed to keep the lower limit nonnegative. Smoothing affects charts only.'])
    return '\n'.join(lines)


def write_outputs(project, cloud, analysis, decoded, entry, retrieved, charts=False, hr_range=None):
    stem = datetime.fromisoformat(cloud['start_local']).strftime('%Y-%m-%d-%H%M%S')
    reports, chart_dir = project / 'reports', project / 'visualizations'
    reports.mkdir(exist_ok=True)
    chart = chart_dir / f'suunto-{stem}-overview.svg'
    svg = chart_svg(decoded, analysis, cloud, hr_range=hr_range) if charts else None
    if svg:
        chart_dir.mkdir(exist_ok=True)
        chart.write_text(svg)
    markdown, json_path = reports / f'suunto-{stem}.md', reports / f'suunto-{stem}.json'
    body = report_body(cloud, analysis, entry, retrieved, str(chart) if svg else None)
    block = f'{START}\n{body}\n{END}'
    previous = markdown.read_text() if markdown.exists() else f'# Workout {stem}\n\n'
    if START in previous and END in previous:
        before, tail = previous.split(START, 1)
        _, after = tail.split(END, 1)
        content = before + block + after
    else:
        content = previous.rstrip() + '\n\n' + block + '\n'
    markdown.write_text(content)
    private_json(json_path, {'retrieved_at_utc': retrieved, 'cloud': cloud, 'fit': analysis,
                             'source': dict(entry), 'chart_path': str(chart) if svg else None})
    return {'markdown_path': str(markdown), 'json_path': str(json_path),
            'chart_path': str(chart) if svg else None}


def cleanup_charts(directory, keep, now=None):
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=30)
    removed = []
    for path in directory.glob('suunto-*.svg'):
        if path.is_symlink() or not path.is_file() or str(path) in keep:
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) >= cutoff:
            continue
        with path.open() as stream:
            owned = CHART_MARKER in stream.read(512)
        if owned:
            path.unlink()
            removed.append(str(path))
    return removed
