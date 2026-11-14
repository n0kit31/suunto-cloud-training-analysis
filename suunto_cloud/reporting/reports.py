"""Generate reusable factual reports and portable SVG charts in the sync process."""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from html import escape
import math
from pathlib import Path
from statistics import median, mean
from typing import Optional

from suunto_cloud.storage.local import private_json
from suunto_cloud.analysis.metrics import active_samples, number, seconds
from suunto_cloud.analysis.chart_metrics import grade_samples, step_length
from suunto_cloud.reporting.recovery import recovery_markdown, recovery_svg

START = '<!-- suunto-generated:start -->'
END = '<!-- suunto-generated:end -->'
CHART_MARKER = '<!-- generated: suunto-analysis -->'


@dataclass
class ChartPanel:
    key: str
    title: str
    groups: list
    lo: float
    hi: float
    color: str
    inverted: bool = False
    style: str = 'area'
    raw_groups: Optional[list] = None
    digits: int = 0


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


def chart_svg(data, analysis, cloud, hr_range=None, recovery=None):
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
    def mapped_groups(observed, smooth=None):
        observed = [(t, value) for t, value in observed if number(value)]
        times = [t for t, _ in observed]
        mapped = []
        for start, end in intervals:
            group = observed[bisect_left(times, start):bisect_left(times, end)]
            mapped.extend((active_time(t), value) for t, value in (smooth(group) if smooth else group))
        return segments(mapped, 2)

    def samples(extract):
        return [(t, value) for t, row in rows if number(value := extract(row))]

    altitude = mapped_groups(samples(lambda r: r.get('altitude')), moving_average)
    pace = mapped_groups(samples(lambda r: pace_from_speed(r.get('speed'))), moving_median)
    panels = []
    if hr:
        lo, hi = hr_range if hr_range is not None else (65, 190)
        panels.append(ChartPanel('heart-rate', 'Heart rate (bpm) · 15 s moving average', [hr], lo, hi, '#b52f3c'))
    if pace:
        lo, hi = doubled_range(pace, minimum_span=0.5, nonnegative=True)
        continuous_pace = [point for group in pace for point in group]
        panels.append(ChartPanel('pace', 'Pace (min/km) · 15 s moving median', [continuous_pace], lo, hi,
                                 '#24679c', inverted=True))
    if altitude:
        lo, hi = doubled_range(altitude, minimum_span=1)
        panels.append(ChartPanel('elevation', 'Elevation (m above sea level) · 15 s moving average',
                                 altitude, lo, hi, '#27704d'))

    def add_metric(key, title, observed, color, minimum_span, smooth=moving_average,
                   style='area', digits=0, nonnegative=True):
        groups = mapped_groups(observed, smooth)
        if not groups:
            return
        raw_groups = mapped_groups(observed) if style == 'scatter' else None
        axis_groups = raw_groups if raw_groups is not None else groups
        if style == 'diverging':
            axis_groups = groups + [[(0, 0)]]
        lo, hi = doubled_range(axis_groups, minimum_span, nonnegative=nonnegative)
        panels.append(ChartPanel(key, title, groups, lo, hi, color, style=style,
                                 raw_groups=raw_groups, digits=digits))

    def nonnegative_field(row, key, positive=False):
        value = row.get(key)
        return value if number(value) and (value > 0 if positive else value >= 0) else None

    sport = (data.get('sessions') or [{}])[0].get('sport')
    running = sport == 'running' or cloud.get('activity_id') in (1, 22)
    on_foot = running or sport in ('walking', 'hiking') or cloud.get('activity_id') == 11
    power_title = 'Running power' if running else 'Power'
    add_metric('power', f'{power_title} (W) · 15 s moving average',
               samples(lambda r: nonnegative_field(r, 'power')), '#b47719', 10)
    cadence_unit, cadence_factor = ('steps/min', 2) if on_foot else ('rpm', 1)
    cadence = [(t, value * cadence_factor) for t, value in
               samples(lambda r: nonnegative_field(r, 'cadence', positive=True))]
    add_metric('cadence', f'Cadence ({cadence_unit}) · dots + 15 s median trend',
               cadence, '#7554a3', 5, smooth=moving_median, style='scatter')
    if on_foot:
        add_metric('ground-contact', 'Ground contact (ms) · dots + 15 s median trend',
                   samples(lambda r: nonnegative_field(r, 'stance_time', positive=True)),
                   '#98603a', 10, smooth=moving_median, style='scatter')
        add_metric('step-length', 'Estimated step length (m) · dots + 15 s median trend',
                   samples(step_length), '#257c84', 0.1, smooth=moving_median,
                   style='scatter', digits=2)
    speed = [(t, value * 3.6) for t, value in samples(lambda r: nonnegative_field(r, 'speed'))]
    add_metric('speed', 'Speed (km/h) · 15 s moving median', speed,
               '#24679c', 1, smooth=moving_median, digits=1)
    add_metric('grade', 'Estimated terrain grade (%) · 50 m window + 15 s mean',
               grade_samples(rows, intervals), '#27704d', 1, style='diverging',
               digits=1, nonnegative=False)
    if not panels:
        return None
    width, left, right, ph, spacing = 1200, 85, 40, 170, 280
    recovery_header, header_offset = recovery_svg(recovery)
    height = 140 + len(panels) * spacing + header_offset
    pw = width - left - right
    x = lambda t: left + t / total * pw
    date = datetime.fromisoformat(cloud['start_local']).strftime('%Y-%m-%d %H:%M')
    lap_by_index = {i: lap for i, lap in enumerate(data.get('laps', []), 1)}
    work_laps = [lap_by_index[r['work_lap_index']]
                 for r in analysis['additional_metrics']['slower_next_lap_hr_changes']]
    subtitle = 'Time axis: active workout time'
    if recovery and recovery.get('nights_7d') and recovery.get('before'):
        subtitle = 'Workout panels: active time · Recovery panels: local wake date'
    if work_laps:
        subtitle += ' · blue bands: interval before a slower workout step'
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
           f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">', CHART_MARKER,
           f'<title id="title">Workout overview {date}</title>',
           '<desc id="desc">Workout panels use active workout time; recovery panels use local wake dates. '
           'Heart rate: centered 15 s moving average, with gaps connected linearly on the chart. '
           'Pace: centered 15 s moving median. Elevation: centered 15 s moving average. '
           'Smoothing resets at pauses and gaps over 2 s. Pace gaps are connected linearly on the chart only; '
           'elevation retains measurement gaps. '
           'Pace and elevation axes double the smoothed min-max span around its midpoint; '
           'pace is bounded below by zero. Minimum data spans: 0.5 min/km and 1 m. '
           'Power: 15 s mean. Speed: 15 s median. Cadence, contact and estimated step length: '
           'observed dots with a 15 s median trend, without area fill. Dots are reduced preserving extrema. '
           'Cadence uses steps/min for running/walking and rpm otherwise. Step length = 30 * speed / cadence. '
           'Grade: local rise/run over up to ±25 m, minimum 20 m and three observations, then 15 s mean. '
           'No grade is estimated across missing inputs, pauses, distance resets or stationary samples. '
           'New axes double the displayed min-max span, including raw dots and zero for grade. '
           'All source data remain unchanged. Areas fill to the panel bottom except signed grade, '
           'which fills toward zero (green uphill, blue downhill). Missing metrics are omitted.</desc>',
           f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
           '<g font-family="Arial, sans-serif" fill="#17212b">',
           f'<text x="85" y="35" font-size="25">Workout overview · {date}</text>',
           f'<text x="85" y="65" font-size="17">{subtitle}</text>']
    out.extend(recovery_header)
    for index, panel in enumerate(panels):
        title, groups, lo, hi = panel.title, panel.groups, panel.lo, panel.hi
        color, inverted = panel.color, panel.inverted
        top = 130 + header_offset + index * spacing
        y = lambda v: top + ((v - lo) if inverted else (hi - v)) / (hi - lo) * ph
        out.extend([f'<g data-metric="{panel.key}" data-style="{panel.style}">',
                    f'<defs><clipPath id="panel-{index}"><rect x="{left}" y="{top}" '
                    f'width="{pw}" height="{ph}"/></clipPath></defs>',
                    f'<text x="{left}" y="{top - 25}" font-size="19">{escape(title)}</text>'])
        for lap in work_laps:
            x1, x2 = x(active_time(seconds(lap['start_time']))), x(active_time(seconds(lap['timestamp'])))
            out.append(f'<rect x="{x1:.2f}" y="{top}" width="{x2 - x1:.2f}" height="{ph}" fill="#e8f0f8"/>')
        for tick in range(6):
            v = lo + tick * (hi - lo) / 5
            label = duration(round(v * 60)).removesuffix('.0') if inverted else display(v, panel.digits)
            out.extend([f'<line x1="{left}" y1="{y(v):.2f}" x2="{width-right}" y2="{y(v):.2f}" stroke="#dce1e6"/>',
                        f'<text x="{left-12}" y="{y(v)+5:.2f}" font-size="16" text-anchor="end">{label}</text>'])
        step = max(60, math.ceil(total / 600) * 60)
        for t in range(0, math.ceil(total) + 1, step):
            out.append(f'<text x="{x(t):.2f}" y="{top+ph+25}" font-size="16" text-anchor="middle">{t // 60}</text>')
        if panel.raw_groups is not None:
            raw_count = sum(len(group) for group in panel.raw_groups)
            for group in panel.raw_groups:
                points = thin(group, max(4, int(600 * len(group) / max(1, raw_count))))
                for when, value in points:
                    out.append(f'<circle cx="{x(when):.2f}" cy="{y(value):.2f}" r="1.8" '
                               f'fill="{color}" fill-opacity="0.35" clip-path="url(#panel-{index})"/>')
        baseline = y(0) if panel.style == 'diverging' else top + ph
        area_color = color
        if panel.style == 'diverging':
            offset = 100 * (0 - lo) / (hi - lo)
            offset = 100 - offset
            out.extend([f'<defs><linearGradient id="grade-{index}" x1="0" y1="{top}" x2="0" '
                        f'y2="{top+ph}" gradientUnits="userSpaceOnUse">',
                        f'<stop offset="{offset:.4f}%" stop-color="#27704d"/>',
                        f'<stop offset="{offset:.4f}%" stop-color="#24679c"/></linearGradient></defs>',
                        f'<line x1="{left}" x2="{width-right}" y1="{baseline:.2f}" y2="{baseline:.2f}" '
                        'stroke="#788795" stroke-dasharray="4 3"/>'])
            area_color = f'url(#grade-{index})'
        count = sum(len(g) for g in groups)
        for group in groups:
            points = thin(group, max(4, int(1600 * len(group) / max(1, count))))
            if len(points) < 2:
                continue
            coords = ' '.join(f'{x(t):.2f},{y(v):.2f}' for t, v in points)
            if panel.style != 'scatter':
                area = f'{x(points[0][0]):.2f},{baseline:.2f} {coords} {x(points[-1][0]):.2f},{baseline:.2f}'
                out.append(f'<polygon points="{area}" fill="{area_color}" fill-opacity="0.25" '
                           f'clip-path="url(#panel-{index})"/>')
            out.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="1.8" '
                       f'clip-path="url(#panel-{index})" stroke-linejoin="round"/>')
        out.extend([f'<text x="{left+pw/2}" y="{top+ph+49}" font-size="16" text-anchor="middle">Active workout time (min)</text>',
                    '</g>'])
    out.extend([f'<text x="85" y="{height-35}" font-size="14">15 s smoothing; HR/pace gaps connected only on chart. '
                'Other gaps retained. Non-HR axes: doubled min-max span.</text>',
                f'<text x="85" y="{height-15}" font-size="14">Dots: observed samples + median trend. '
                'Grade: 50 m rise/run; green uphill, blue downhill. Missing metrics omitted.</text>', '</g></svg>'])
    return '\n'.join(out) + '\n'


def report_body(cloud, analysis, entry, retrieved, chart, recovery=None):
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
             *recovery_markdown(recovery),
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
        lines.extend(['', f'[Workout metric charts]({chart})'])
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
        lines.extend(['', 'Additional charts are included only when their measurements exist. '
                      'Power: 15 s mean and filled line. Speed: 15 s median in km/h and filled line. '
                      'Cadence, ground contact and estimated step length: observed dots (reduced preserving extrema) '
                      'with a 15 s median trend, no area fill. Their doubled axis ranges include the observed dots. '
                      'Running/walking cadence is converted from cycles/min to steps/min; '
                      'other cadence remains rpm. Ground contact is in ms. '
                      'Estimated single step length = 30 * simultaneous speed (m/s) / cadence (cycles/min); '
                      'missing or nonpositive speed/cadence pairs are omitted.', '',
                      'Estimated terrain grade is 100 * rise/run across actual endpoint samples '
                      'within ±25 m, requiring at least 20 m and three distinct distance observations, '
                      'then a centered 15 s mean. Windows do not cross pauses, input gaps >2 s, '
                      'missing elevation/distance, distance resets, or stationary stretches >2 s. '
                      'It is a local estimate, not a surveyed gradient. Its doubled range includes zero; '
                      'green/blue areas show uphill/downhill relative to zero. '
                      'New chart gaps remain visible. Source measurements and workout statistics are unchanged.'])
    return '\n'.join(lines)


def write_outputs(project, cloud, analysis, decoded, entry, retrieved, charts=False, hr_range=None,
                  recovery=None):
    stem = datetime.fromisoformat(cloud['start_local']).strftime('%Y-%m-%d-%H%M%S')
    reports, chart_dir = project / 'reports', project / 'visualizations'
    reports.mkdir(exist_ok=True)
    chart = chart_dir / f'suunto-{stem}-overview.svg'
    svg = chart_svg(decoded, analysis, cloud, hr_range=hr_range, recovery=recovery) if charts else None
    if svg:
        chart_dir.mkdir(exist_ok=True)
        chart.write_text(svg)
    markdown, json_path = reports / f'suunto-{stem}.md', reports / f'suunto-{stem}.json'
    body = report_body(cloud, analysis, entry, retrieved, str(chart) if svg else None, recovery)
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
                             'source': dict(entry), 'recovery': recovery,
                             'chart_path': str(chart) if svg else None})
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
