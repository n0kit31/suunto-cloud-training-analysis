"""Generate factual reports and portable interactive charts in the sync process."""

from datetime import datetime, timezone, timedelta
from html import escape
import json
import math
from pathlib import Path

from suunto_cloud.storage.local import cloud_artifact_stem, private_json, private_text
from suunto_cloud.analysis.metrics import number
from suunto_cloud.analysis.workout_highlights import cloud_recovery_times, workout_highlights
from suunto_cloud.reporting.recovery import recovery_markdown, recovery_svg, workout_feeling
from suunto_cloud.reporting.interactive import chart_html
from suunto_cloud.reporting.workout_tiles import post_workout_hr, recovery_labels, workout_tiles_svg
from suunto_cloud.analysis.chart_summary import chart_summary
from suunto_cloud.analysis.sleep import recovery_context
from suunto_cloud.storage.comparison import comparison_workouts
from suunto_cloud.storage.sleep import read_sleep

from suunto_cloud.reporting.chart_model import (
    LEFT, PANEL_HEIGHT, PANEL_SPACING, PLOT_WIDTH, RIGHT, TICK_SECONDS, WIDTH,
    interaction_payload, panel_geometry, panel_y, prepare_chart,
)
from suunto_cloud.reporting.chart_model import moving_average, pace_from_speed, pace_series, workout_time_label

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


def chart_svg(data, analysis, cloud, hr_range=None, recovery=None, interaction=None):
    svg, payload = _workout_chart(data, analysis, cloud, hr_range, recovery, interactive=interaction is not None)
    if payload is not None:
        interaction.update(payload)
    return svg


def _workout_chart(data, analysis, cloud, hr_range, recovery, interactive):
    chart = prepare_chart(data, analysis, cloud, hr_range, interactive)
    if chart is None:
        return None, None
    tiles, tile_offset = workout_tiles_svg(cloud, workout_highlights(cloud, analysis))
    recovery_header, recovery_offset = recovery_svg(recovery, (cloud.get('summary') or {}).get('feeling'))
    if tile_offset and recovery_header:
        recovery_header = [f'<g transform="translate(0 {tile_offset})">', *recovery_header, '</g>']
    header_offset = tile_offset + recovery_offset
    svg = _render_chart_svg(chart, recovery, tiles + recovery_header, header_offset)
    return svg, interaction_payload(chart, header_offset) if interactive else None


def _render_chart_svg(chart, recovery, header, header_offset):
    width, left, right, ph, pw = WIDTH, LEFT, RIGHT, PANEL_HEIGHT, PLOT_WIDTH
    panels, total, work_bands = chart.panels, chart.total_seconds, chart.work_bands
    height = 140 + len(panels) * PANEL_SPACING + header_offset
    x = lambda t: left + t / total * pw
    heading = escape(chart.title)
    heading_size = 25 if len(chart.title) <= 85 else 20
    subtitle = 'Time axis: active workout time'
    if recovery and recovery.get('nights_7d') and recovery.get('before'):
        subtitle = 'Workout panels: active time · Recovery panels: local wake date'
    if work_bands:
        subtitle += ' · blue bands: interval before a slower workout step'
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
           f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">', CHART_MARKER,
           f'<title id="title">{heading}</title>',
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
           f'<text x="85" y="35" font-size="{heading_size}">{heading}</text>',
           f'<text x="85" y="65" font-size="17">{subtitle}</text>']
    out.extend(header)
    for index, panel in enumerate(panels):
        title, groups, lo, hi = panel.title, panel.groups, panel.lo, panel.hi
        color, inverted = panel.color, panel.inverted
        top, baseline, clip_path, area_color = panel_geometry(panel, index, header_offset)
        y = lambda value: panel_y(panel, top, value)
        out.extend([f'<g data-metric="{panel.key}" data-style="{panel.style}">',
                    f'<defs><clipPath id="panel-{index}"><rect x="{left}" y="{top}" '
                    f'width="{pw}" height="{ph}"/></clipPath></defs>',
                    f'<text x="{left}" y="{top - 25}" font-size="19">{escape(title)}</text>'])
        for start, end in work_bands:
            x1, x2 = x(start), x(end)
            out.append(f'<rect data-full-plot="" x="{x1:.2f}" y="{top}" width="{x2 - x1:.2f}" height="{ph}" fill="#e8f0f8"/>')
        for tick in range(6):
            v = lo + tick * (hi - lo) / 5
            label = duration(round(v * 60)).removesuffix('.0') if inverted else display(v, panel.digits)
            out.extend([f'<line x1="{left}" y1="{y(v):.2f}" x2="{width-right}" y2="{y(v):.2f}" stroke="#dce1e6"/>',
                        f'<text x="{left-12}" y="{y(v)+5:.2f}" font-size="16" text-anchor="end">{label}</text>'])
        for t in range(0, math.floor(total) + 1, TICK_SECONDS):
            out.extend([f'<line data-full-plot="" data-active-tick="{t}" x1="{x(t):.2f}" x2="{x(t):.2f}" '
                        f'y1="{top}" y2="{top+ph}" stroke="#dce1e6"/>',
                        f'<text data-full-plot="" x="{x(t):.2f}" y="{top+ph+25}" font-size="16" text-anchor="middle">{t // 60}</text>'])
        if panel.raw_groups is not None:
            raw_count = sum(len(group) for group in panel.raw_groups)
            for group in panel.raw_groups:
                points = thin(group, max(4, int(600 * len(group) / max(1, raw_count))))
                for when, value in points:
                    out.append(f'<circle data-full-plot="" cx="{x(when):.2f}" cy="{y(value):.2f}" r="1.8" '
                               f'fill="{color}" fill-opacity="0.35" clip-path="{clip_path}"/>')
        if panel.style == 'diverging':
            offset = 100 * (0 - lo) / (hi - lo)
            offset = 100 - offset
            out.extend([f'<defs><linearGradient id="grade-{index}" x1="0" y1="{top}" x2="0" '
                        f'y2="{top+ph}" gradientUnits="userSpaceOnUse">',
                        f'<stop offset="{offset:.4f}%" stop-color="#27704d"/>',
                        f'<stop offset="{offset:.4f}%" stop-color="#24679c"/></linearGradient></defs>',
                        f'<line x1="{left}" x2="{width-right}" y1="{baseline:.2f}" y2="{baseline:.2f}" '
                        'stroke="#788795" stroke-dasharray="4 3"/>'])
        count = sum(len(g) for g in groups)
        for group in groups:
            points = thin(group, max(4, int(1600 * len(group) / max(1, count))))
            if len(points) < 2:
                continue
            coords = ' '.join(f'{x(t):.2f},{y(v):.2f}' for t, v in points)
            if panel.style != 'scatter':
                area = f'{x(points[0][0]):.2f},{baseline:.2f} {coords} {x(points[-1][0]):.2f},{baseline:.2f}'
                out.append(f'<polygon data-full-plot="" points="{area}" fill="{area_color}" fill-opacity="0.25" '
                           f'clip-path="{clip_path}"/>')
            out.append(f'<polyline data-full-plot="" points="{coords}" fill="none" stroke="{color}" stroke-width="1.8" '
                       f'clip-path="{clip_path}" stroke-linejoin="round"/>')
        out.extend([f'<text x="{left+pw/2}" y="{top+ph+49}" font-size="16" text-anchor="middle">Active workout time (min)</text>',
                    '</g>'])
    out.extend([f'<text x="85" y="{height-35}" font-size="14">15 s smoothing; HR/pace gaps connected only on chart. '
                'Other gaps retained. Non-HR axes: doubled min-max span.</text>',
                f'<text x="85" y="{height-15}" font-size="14">Dots: observed samples + median trend. '
                'Grade: 50 m rise/run; green uphill, blue downhill. Missing metrics omitted.</text>', '</g></svg>'])
    return '\n'.join(out) + '\n'


def report_body(cloud, analysis, entry, retrieved, chart, recovery=None):
    summary, details = cloud['summary'], analysis['additional_metrics']
    feeling = workout_feeling(summary.get('feeling'))['rating']
    highlights = workout_highlights(cloud, analysis)
    highlight_rows = []
    if highlights['temperature_c'] is not None:
        temperature = display(highlights['temperature_c'])
        highlight_rows.append(f'| Average workout temperature | {temperature} °C (watch sensor) |')
    hr = post_workout_hr(cloud)
    if hr and hr[1]:
        change, rating, _ = hr
        highlight_rows.append(f'| Post-workout HR change (Suunto) | {change} · {rating} |')
    if highlights['recovery_seconds'] is not None:
        estimate, kind, until = recovery_labels(highlights)
        deadline = f' · {until}' if until else ''
        highlight_rows.append(f'| Suunto recovery time | {estimate} ({kind.lower()}){deadline} |')
    zone = cloud.get('timezone') or datetime.fromisoformat(cloud['start_local']).tzname()
    local_fit = entry.get('source_type') == 'local_fit'
    distance = cloud['distance_m']
    provenance = (f"Imported from local FIT: {retrieved}; timezone {zone}." if local_fit else
                  f"Retrieved: {retrieved}; timezone {zone}; ID `{cloud['workout_key']}`.")
    lines = [provenance, '',
             '| Metric | Value |', '| --- | --- |',
             f"| Distance | {display(distance / 1000 if number(distance) else None, 3)} km |",
             f"| Active / elapsed time | {duration(cloud['active_seconds'])} / {duration(cloud['elapsed_seconds'])} |",
             f"| Active pace | {duration(cloud['pace_seconds_per_km'])}/km |",
             f"| Average / maximum HR | {cloud['avg_hr_bpm']} / {cloud['max_hr_bpm']} |",
             f"| Ascent / descent | {display(cloud['ascent_m'])} / {display(cloud['descent_m'])} m |",
             f"| TSS | {display((cloud['tss'] or {}).get('trainingStressScore'), 3)}; {(cloud['tss'] or {}).get('calculationMethod')} |",
             f"| PTE / estimated VO₂max | {display(summary.get('pte'))} / {display((cloud['fitness'] or {}).get('estimatedVo2Max'))} |",
             f"| Workout feeling | {str(feeling) + '/5 (recorded after workout)' if feeling is not None else '—'} |",
             *highlight_rows,
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
                  recovery=None, week_workouts=None, report_path=None):
    reports, chart_dir = project / 'reports', project / 'visualizations'
    start = datetime.fromisoformat(cloud['start_local'])
    legacy_stem = start.strftime('%Y-%m-%d-%H%M%S')
    workout_key = cloud.get('workout_key')
    if report_path is None:
        stem = legacy_stem
        if entry.get('source_type') == 'local_fit':
            stem += f"-fit-{entry['fit_sha256'][:16]}"
        elif workout_key:
            stem = cloud_artifact_stem(start, workout_key)
        report_path = reports / f'suunto-{stem}.json'
    else:
        stem = report_path.stem.removeprefix('suunto-')
    markdown = report_path.with_suffix('.md')
    chart = chart_dir / f'{report_path.stem}-overview.html'
    svg_path = chart.with_suffix('.svg')
    summary = chart_summary(cloud, analysis, week_workouts) if charts else None
    svg, interaction = (_workout_chart(decoded, analysis, cloud, hr_range, recovery, interactive=True)
                        if charts else (None, None))
    html = chart_html(svg, interaction, svg_path.name, summary) if svg else None
    body = report_body(cloud, analysis, entry, retrieved, str(chart) if svg else None, recovery)
    block = f'{START}\n{body}\n{END}'
    legacy = reports / f'suunto-{legacy_stem}.json'
    if markdown.exists():
        previous = markdown.read_text()
    elif workout_key and entry.get('source_type') != 'local_fit' and report_path != legacy:
        previous = _legacy_markdown(legacy, workout_key)
    else:
        previous = None
    if previous is None:
        previous = f'# Workout {stem}\n\n'
    if START in previous and END in previous:
        before, tail = previous.split(START, 1)
        _, after = tail.split(END, 1)
        content = before + block + after
    else:
        content = previous.rstrip() + '\n\n' + block + '\n'
    if svg:
        private_text(svg_path, svg)
        private_text(chart, html)
    private_text(markdown, content)
    private_json(report_path, {'retrieved_at_utc': retrieved, 'cloud': cloud, 'fit': analysis,
                             'source': dict(entry), 'recovery': recovery,
                             'chart_path': str(chart) if svg else None,
                             'svg_path': str(svg_path) if svg else None,
                             'chart_summary': summary})
    return {'markdown_path': str(markdown), 'json_path': str(report_path),
            'chart_path': str(chart) if svg else None, 'svg_path': str(svg_path) if svg else None}


def _legacy_markdown(report_path, workout_key):
    try:
        legacy = json.loads(report_path.read_text())
        if legacy['cloud']['workout_key'] == workout_key:
            return report_path.with_suffix('.md').read_text()
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        pass
    return None


def _restore_recovery_times(cloud, source):
    raw_path = source.get('cloud_summary_path')
    if 'cumulative_recovery_seconds' in cloud or not cloud.get('workout_key') or not raw_path:
        return cloud
    try:
        raw = json.loads(Path(raw_path).read_text())
    except (OSError, ValueError, TypeError):
        return cloud
    if isinstance(raw, dict) and raw.get('workoutKey') == cloud['workout_key']:
        return {**cloud, **cloud_recovery_times(raw)}
    return cloud


def regenerate_report(report_path, hr_range=None, sleep_data=None):
    report_path = report_path.resolve(strict=True)
    project = report_path.parent.parent
    report = json.loads(report_path.read_text())
    source = report['source']
    cloud = _restore_recovery_times(report['cloud'], source)
    decoded = json.loads(Path(source['decoded_path']).read_text())
    recovery = (recovery_context(cloud, read_sleep(sleep_data, required=True))
                if sleep_data else report.get('recovery'))
    peers = (None if source.get('source_type') == 'local_fit' else
             comparison_workouts(project, cloud, report.get('chart_summary')))
    outputs = write_outputs(project, cloud, report['fit'], decoded, source, report['retrieved_at_utc'],
                            charts=True, hr_range=hr_range, recovery=recovery, week_workouts=peers,
                            report_path=report_path)
    prune_report_charts(project, [outputs])
    return outputs


def prune_report_charts(project, reports):
    keep = {report[field] for report in reports for field in ('chart_path', 'svg_path')}
    return cleanup_charts(project / 'visualizations', keep)


def cleanup_charts(directory, keep, now=None):
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=30)
    removed = []
    for path in sorted(directory.glob('suunto-*')):
        if path.suffix.lower() not in {'.svg', '.html', '.png'}:
            continue
        if path.is_symlink() or not path.is_file() or str(path) in keep:
            continue
        if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) >= cutoff:
            continue
        with path.open('rb') as stream:
            owned = CHART_MARKER.encode() in stream.read(512)
        if owned:
            path.unlink()
            removed.append(str(path))
    return removed
