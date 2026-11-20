"""Prepare workout panels and active-time observations for SVG and interactive charts."""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from statistics import mean, median
from typing import Optional

from suunto_cloud.activities import activity_label
from suunto_cloud.analysis.chart_metrics import grade_samples, step_length
from suunto_cloud.analysis.metrics import active_samples, number, seconds


WIDTH, LEFT, RIGHT = 1200, 85, 40
PLOT_WIDTH = WIDTH - LEFT - RIGHT
PANEL_HEIGHT, PANEL_SPACING = 170, 280
TICK_SECONDS = 600


@dataclass
class ChartPanel:
    key: str
    title: str
    groups: list
    lo: float
    hi: float
    color: str
    unit: str
    inverted: bool = False
    style: str = 'area'
    raw_groups: Optional[list] = None
    digits: int = 0


@dataclass
class WorkoutChart:
    title: str
    total_seconds: float
    panels: list
    work_bands: list
    laps: list = field(default_factory=list)
    distance: list = field(default_factory=list)
    observed_hr: list = field(default_factory=list)
    observed_power: list = field(default_factory=list)


def workout_time_label(cloud):
    start = datetime.fromisoformat(cloud['start_local'])
    label = start.strftime('%Y-%m-%d %H:%M')
    if cloud.get('stop_local'):
        stop = datetime.fromisoformat(cloud['stop_local'])
        if stop.date() == start.date():
            label += stop.strftime('–%H:%M')
        else:
            label += stop.strftime(' – %Y-%m-%d %H:%M')
    return label


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


def prepare_chart(data, analysis, cloud, hr_range=None, interactive=False):
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
        panels.append(ChartPanel('heart-rate', 'Heart rate (bpm) · 15 s moving average', [hr], lo, hi, '#b52f3c', 'bpm'))
    if pace:
        lo, hi = doubled_range(pace, minimum_span=0.5, nonnegative=True)
        continuous_pace = [point for group in pace for point in group]
        panels.append(ChartPanel('pace', 'Pace (min/km) · 15 s moving median', [continuous_pace], lo, hi,
                                 '#24679c', 'min/km', inverted=True))
    if altitude:
        lo, hi = doubled_range(altitude, minimum_span=1)
        panels.append(ChartPanel('elevation', 'Elevation (m above sea level) · 15 s moving average',
                                 altitude, lo, hi, '#27704d', 'm'))

    def add_metric(key, title, observed, color, unit, minimum_span, smooth=moving_average,
                   style='area', digits=0, nonnegative=True):
        groups = mapped_groups(observed, smooth)
        if not groups:
            return
        raw_groups = mapped_groups(observed) if style == 'scatter' else None
        axis_groups = raw_groups if raw_groups is not None else groups
        if style == 'diverging':
            axis_groups = groups + [[(0, 0)]]
        lo, hi = doubled_range(axis_groups, minimum_span, nonnegative=nonnegative)
        panels.append(ChartPanel(key, title, groups, lo, hi, color, unit, style=style,
                                 raw_groups=raw_groups, digits=digits))

    def nonnegative_field(row, key, positive=False):
        value = row.get(key)
        return value if number(value) and (value > 0 if positive else value >= 0) else None

    sport = (data.get('sessions') or [{}])[0].get('sport')
    running = sport == 'running' or cloud.get('activity_id') in (1, 22)
    on_foot = running or sport in ('walking', 'hiking') or cloud.get('activity_id') == 11
    power_title = 'Running power' if running else 'Power'
    add_metric('power', f'{power_title} (W) · 15 s moving average',
               samples(lambda r: nonnegative_field(r, 'power')), '#b47719', 'W', 10)
    cadence_unit, cadence_factor = ('steps/min', 2) if on_foot else ('rpm', 1)
    cadence = [(t, value * cadence_factor) for t, value in
               samples(lambda r: nonnegative_field(r, 'cadence', positive=True))]
    add_metric('cadence', f'Cadence ({cadence_unit}) · dots + 15 s median trend',
               cadence, '#7554a3', cadence_unit, 5, smooth=moving_median, style='scatter')
    if on_foot:
        add_metric('ground-contact', 'Ground contact (ms) · dots + 15 s median trend',
                   samples(lambda r: nonnegative_field(r, 'stance_time', positive=True)),
                   '#98603a', 'ms', 10, smooth=moving_median, style='scatter')
        add_metric('step-length', 'Estimated step length (m) · dots + 15 s median trend',
                   samples(step_length), '#257c84', 'm', 0.1, smooth=moving_median,
                   style='scatter', digits=2)
    speed = [(t, value * 3.6) for t, value in samples(lambda r: nonnegative_field(r, 'speed'))]
    add_metric('speed', 'Speed (km/h) · 15 s moving median', speed,
               '#24679c', 'km/h', 1, smooth=moving_median, digits=1)
    add_metric('grade', 'Estimated terrain grade (%) · 50 m window + 15 s mean',
               grade_samples(rows, intervals), '#27704d', '%', 1, style='diverging',
               digits=1, nonnegative=False)
    if not panels:
        return None
    date = workout_time_label(cloud)
    activity = activity_label(cloud, data)
    heading_text = ' · '.join(part for part in ('Workout overview', activity, date) if part)
    raw_laps = data.get('laps', [])
    work_laps = [raw_laps[r['work_lap_index'] - 1]
                 for r in analysis['additional_metrics']['slower_next_lap_hr_changes']]
    work_bands = [(active_time(seconds(lap['start_time'])), active_time(seconds(lap['timestamp'])))
                  for lap in work_laps]
    chart = WorkoutChart(heading_text, total, panels, work_bands)
    if interactive:
        details = analysis['additional_metrics']
        preferred = set(details['preferred_lap_indices'])
        for lap in analysis['laps']:
            if lap['index'] not in preferred:
                continue
            raw_lap = raw_laps[lap['index'] - 1]
            start = active_time(seconds(raw_lap['start_time']))
            end = active_time(seconds(raw_lap['timestamp']))
            if start < end:
                label = 'Workout step' if details['preferred_lap_kind'] == 'guided' else 'Lap'
                chart.laps.append({
                    'label': f'{label} {len(chart.laps) + 1}', 'start': start, 'end': end,
                    **{key: lap[key] for key in ('distance_m', 'active_seconds', 'avg_hr', 'max_hr', 'avg_power_w')},
                })
        chart.distance = [(active_time(t), d / 1000) for t, d in samples(lambda row: row.get('distance'))]
        chart.observed_hr = [(active_time(t), v) for t, v in hr_observed]
        chart.observed_power = [(active_time(t), v) for t, v in samples(lambda r: nonnegative_field(r, 'power'))]
    return chart


def panel_y(panel, top, value):
    offset = value - panel.lo if panel.inverted else panel.hi - value
    return top + offset / (panel.hi - panel.lo) * PANEL_HEIGHT


def panel_geometry(panel, index, header_offset):
    top = 130 + header_offset + index * PANEL_SPACING
    baseline = panel_y(panel, top, 0) if panel.style == 'diverging' else top + PANEL_HEIGHT
    clip_path = f'url(#panel-{index})'
    area_color = f'url(#grade-{index})' if panel.style == 'diverging' else panel.color
    return top, baseline, clip_path, area_color


def interaction_payload(chart, header_offset):
    def series(points):
        return [[round(t, 3), round(value, 6)] for t, value in points]

    panels = []
    for index, panel in enumerate(chart.panels):
        top, baseline, clip_path, area_color = panel_geometry(panel, index, header_offset)
        panels.append({
            'key': panel.key, 'label': panel.title.split(' · ')[0], 'unit': panel.unit, 'color': panel.color,
            'lo': panel.lo, 'hi': panel.hi, 'inverted': panel.inverted, 'digits': panel.digits, 'top': top,
            'style': panel.style, 'baseline': baseline, 'clip_path': clip_path, 'area_color': area_color,
            # Full smoothed observations, before visual thinning.
            'points': series(point for group in panel.groups for point in group),
            'group_sizes': [len(group) for group in panel.groups],
            'dots': series(point for group in (panel.raw_groups or []) for point in group),
        })
    return {
        'title': chart.title, 'total_seconds': chart.total_seconds, 'left': LEFT, 'plot_width': PLOT_WIDTH,
        'panel_height': PANEL_HEIGHT, 'tick_seconds': TICK_SECONDS, 'panels': panels,
        'laps': chart.laps, 'work_bands': chart.work_bands, 'distance': series(chart.distance),
        'observed_hr': series(chart.observed_hr), 'observed_power': series(chart.observed_power),
    }
