"""Generate reusable factual reports and portable SVG charts in the sync process."""

from collections import defaultdict
from datetime import datetime, timezone, timedelta
from html import escape
import math
from pathlib import Path
from statistics import median, mean

from access import private_json
from analysis_details import active_samples, number, seconds

START = '<!-- suunto-generated:start -->'
END = '<!-- suunto-generated:end -->'
CHART_MARKER = '<!-- generated: suunto-analysis -->'


def duration(value):
    if not number(value):
        return '—'
    value = round(value, 1)
    return f'{int(value // 60)}:{value % 60:04.1f}'.replace('.', ',')


def display(value, digits=1):
    return '—' if value is None else f'{value:.{digits}f}'.replace('.', ',') if number(value) else str(value)


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


def chart_svg(data, analysis, cloud):
    rows = active_samples(data, analysis['timer'])
    if not rows:
        return None
    origin = seconds(data['sessions'][0].get('start_time') or analysis['timer']['active_segments'][0]['start'])
    end = max(rows[-1][0], seconds(data['sessions'][0].get('timestamp') or analysis['timer']['active_segments'][-1]['end']))
    total = max(1, end - origin)
    hr = [(t - origin, r['heart_rate']) for t, r in rows if number(r.get('heart_rate'))]
    altitude = [(t - origin, r['altitude']) for t, r in rows if number(r.get('altitude'))]
    pace = pace_series(rows, origin)
    panels = []
    if hr:
        lo, hi = math.floor(min(v for _, v in hr) / 10) * 10, math.ceil(max(v for _, v in hr) / 10) * 10
        panels.append(('Tętno (uderzenia/min)', segments(hr, 2), lo, max(lo + 10, hi), '#b52f3c', False))
    if pace:
        lo = max(0.5, math.floor(min(v for _, v in pace) * 2) / 2)
        hi = max(lo + 1, min(15, math.ceil(max(v for _, v in pace))))
        panels.append(('Tempo (min/km) · mediana 10 s', segments(pace, 15), lo, hi, '#24679c', True))
    if altitude:
        lo = math.floor(min(v for _, v in altitude) / 10) * 10
        hi = max(lo + 10, math.ceil(max(v for _, v in altitude) / 10) * 10)
        panels.append(('Wysokość (m n.p.m.)', segments(altitude, 2), lo, hi, '#27704d', False))
    if not panels:
        return None
    width, left, right, ph, spacing = 1200, 85, 40, 170, 250
    height = 130 + len(panels) * spacing
    pw = width - left - right
    x = lambda t: left + t / total * pw
    date = datetime.fromisoformat(cloud['start_local']).strftime('%d.%m.%Y %H:%M')
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
           f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">', CHART_MARKER,
           f'<title id="title">Przebieg treningu {date}</title>',
           '<desc id="desc">Aktywne obserwacje. Szare pasma oznaczają pauzy timera. '
           'Tempo to mediana w oknach 10 s; linie nie łączą długich luk. Oś czasu obejmuje pauzy.</desc>',
           f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
           '<g font-family="Arial, sans-serif" fill="#17212b">',
           f'<text x="85" y="35" font-size="25">Przebieg treningu · {date}</text>',
           '<text x="85" y="65" font-size="17">Niebieskie pasma: odcinek przed wolniejszym krokiem treningu · szare: pauzy</text>']
    lap_by_index = {i: lap for i, lap in enumerate(data.get('laps', []), 1)}
    work_laps = [lap_by_index[r['work_lap_index']]
                 for r in analysis['additional_metrics']['slower_next_lap_hr_changes']]
    for index, (title, groups, lo, hi, color, inverted) in enumerate(panels):
        top = 130 + index * spacing
        y = lambda v: top + ((v - lo) if inverted else (hi - v)) / (hi - lo) * ph
        out.extend([f'<defs><clipPath id="panel-{index}"><rect x="{left}" y="{top}" '
                    f'width="{pw}" height="{ph}"/></clipPath></defs>',
                    f'<text x="{left}" y="{top - 25}" font-size="19">{escape(title)}</text>'])
        for lap in work_laps:
            x1, x2 = x(seconds(lap['start_time']) - origin), x(seconds(lap['timestamp']) - origin)
            out.append(f'<rect x="{x1:.2f}" y="{top}" width="{x2 - x1:.2f}" height="{ph}" fill="#e8f0f8"/>')
        for pause in analysis['timer']['pauses']:
            x1, x2 = x(seconds(pause['start']) - origin), x(seconds(pause['end']) - origin)
            out.append(f'<rect x="{x1:.2f}" y="{top}" width="{x2 - x1:.2f}" height="{ph}" fill="#dce1e6"/>')
        for tick in range(6):
            v = lo + tick * (hi - lo) / 5
            label = duration(v * 60).removesuffix(',0') if inverted else display(v, 0)
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
            out.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="1.8" '
                       f'clip-path="url(#panel-{index})" stroke-linejoin="round"/>')
        out.append(f'<text x="{left+pw/2}" y="{top+ph+49}" font-size="16" text-anchor="middle">Czas od startu (min)</text>')
    out.extend([f'<text x="85" y="{height-15}" font-size="15">Tempo: mediana 10 s, oś do 15 min/km. '
                'Bez próbek z pauz; redukcja punktów zachowuje skrajne wartości.</text>', '</g></svg>'])
    return '\n'.join(out) + '\n'


def report_body(cloud, analysis, entry, retrieved, chart):
    summary, details = cloud['summary'], analysis['additional_metrics']
    lines = [f"Pobranie: {retrieved}; strefa Europe/Warsaw; ID `{cloud['workout_key']}`.", '',
             '| Metryka | Wartość |', '| --- | --- |',
             f"| Dystans | {display(cloud['distance_m'] / 1000, 3)} km |",
             f"| Czas aktywny / elapsed | {duration(cloud['active_seconds'])} / {duration(cloud['elapsed_seconds'])} |",
             f"| Tempo aktywne | {duration(cloud['pace_seconds_per_km'])}/km |",
             f"| HR średnie / maksymalne | {cloud['avg_hr_bpm']} / {cloud['max_hr_bpm']} |",
             f"| Podejścia / zejścia | {display(cloud['ascent_m'])} / {display(cloud['descent_m'])} m |",
             f"| TSS | {display((cloud['tss'] or {}).get('trainingStressScore'), 3)}; {(cloud['tss'] or {}).get('calculationMethod')} |",
             f"| PTE / VO₂max estymowane | {display(summary.get('pte'))} / {display((cloud['fitness'] or {}).get('estimatedVo2Max'))} |",
             '', '## Międzyczasy i mechanika', '',
             'Wybrano jeden rozłączny rodzaj okrążeń. Tempo z czasu aktywnego i dystansu; mechanika z dostępnych wspólnych próbek.', '',
             '| Okr. | m | Czas | Tempo/km | HR śr./maks. | W | +m/−m | Kroki/min | Kontakt ms | Oscylacja cm | Krok m (wyliczony) |',
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
    lines.extend(['', '## Pauzy i HR po zwolnieniu', ''])
    for pause in analysis['timer']['pauses']:
        lines.append(f"- {pause['start']}–{pause['end']}: {duration(pause['seconds'])}; powód nieznany.")
    if not analysis['timer']['pauses']:
        lines.append('Brak pauz potwierdzonych zdarzeniami timera.')
    for recovery in details['slower_next_lap_hr_changes']:
        lines.append(f"- Okrążenie {recovery['work_lap_index']} → {recovery['slower_next_lap_index']}: "
                     f"zmiana HR po 60 s {display(recovery['hr_drop_after_60_seconds'], 0)}/min; "
                     f"pauza w następnym kroku: {recovery['pause_in_next_lap']}. To nie test kliniczny HRR.")
    lines.extend(['', '## Intensywność i dane uzupełniające', ''])
    hr_zones = ((cloud.get('intensity') or {}).get('zones') or {}).get('heartRate', {})
    for name, zone in hr_zones.items():
        value = zone.get('totalTime')
        if number(value):
            lines.append(f"- HR {name}: {duration(value)}; dolna granica {display(zone.get('lowerLimit'), 0)}/min.")
    zone_sense = (cloud.get('zone_sense') or {}).get('zones', {})
    if zone_sense:
        lines.append('- ZoneSense (osobna klasyfikacja, bez procentów czasu aktywnego): ' + '; '.join(
            f'{key}: {duration(value / 1000)}' for key, value in zone_sense.items()
            if key.endswith('Ms') and number(value)))
    for channel in details['suuntoplus_channels']:
        lines.append(f"- SuuntoPlus {channel['label']}: jednostka `{channel['unit']}`, "
                     f"{channel['active_sample_count']} aktywnych próbek, ostatnia wartość "
                     f"{display(channel['last_active_value'], 3)}, wynik sesji {display(channel['session_value'], 3)}.")
    lines.extend(['', 'Estymatory czasu maratonu opisują projekcję aplikacji z tempa, nie maksymalne możliwości. '
                  'TSS z różnych metod nie sumuje się. Progi mocy, jednostka korekty tempa, '
                  'brakujące progi ZoneSense i artefakty R-R wymagają osobnej oceny przed interpretacją.', '',
                  details['method'], '', 'Pełne dane, liczebności próbek i dodatkowe pola są w sąsiednim JSON; '
                  f"oryginalny FIT: `{entry['fit_path']}`, SHA-256 `{entry['fit_sha256']}`."])
    if chart:
        lines.extend(['', f'[Przebieg tętna, tempa i wysokości]({chart})'])
    return '\n'.join(lines)


def write_outputs(project, cloud, analysis, decoded, entry, retrieved, charts=False):
    stem = datetime.fromisoformat(cloud['start_local']).strftime('%Y-%m-%d-%H%M%S')
    reports, chart_dir = project / 'reports', project / 'visualizations'
    reports.mkdir(exist_ok=True)
    chart = chart_dir / f'suunto-{stem}-przebieg.svg'
    svg = chart_svg(decoded, analysis, cloud) if charts else None
    if svg:
        chart_dir.mkdir(exist_ok=True)
        chart.write_text(svg)
    markdown, json_path = reports / f'suunto-{stem}.md', reports / f'suunto-{stem}.json'
    body = report_body(cloud, analysis, entry, retrieved, str(chart) if svg else None)
    block = f'{START}\n{body}\n{END}'
    previous = markdown.read_text() if markdown.exists() else f'# Trening {stem}\n\n'
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
