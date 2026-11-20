"""Render workout conditions and post-workout recovery in the chart header."""

from datetime import datetime
from html import escape

from suunto_cloud.analysis.metrics import number
from suunto_cloud.analysis.workout_highlights import celsius_from_kelvin
from suunto_cloud.reporting.chart_model import LEFT, PLOT_WIDTH
from suunto_cloud.reporting.recovery import sleep_time, value
from suunto_cloud.reporting.recovery_charts import STATUS_COLORS


PALETTES = {
    'cold': ('#e8f3ff', '#225c91', '#bcd9f5'),
    'mild': ('#e9f7f3', '#206a5d', '#bcded5'),
    'hot': STATUS_COLORS['red'][:3],
    'weather': ('#f0f6fb', '#345875', '#d6e4ef'),
    'recovery': ('#f2effb', '#544383', '#ded5f1'),
    **{key: STATUS_COLORS[key][:3] for key in ('green', 'yellow', 'red', 'unknown')},
}
HR_RATINGS = {'Excellent': 'green', 'Normal': 'yellow', 'Slow': 'red'}
CONDITIONS = {'01': 'Clear sky', '02': 'Partly cloudy', '03': 'Scattered clouds',
              '04': 'Broken clouds', '09': 'Showers', '10': 'Rain', '11': 'Thunderstorm',
              '13': 'Snow', '50': 'Mist'}

SUN = ('<circle cx="22" cy="23" r="10" fill="#f7bb4c"/>'
       '<path d="M22 5v5m0 26v5M4 23h5m26 0h5M9 10l4 4m18 18 4 4M9 36l4-4m18-18 4-4" '
       'fill="none" stroke="#cc801b" stroke-width="2" stroke-linecap="round"/>')
MOON = '<path d="M26 7a15 15 0 1 0 12 20A14 14 0 0 1 26 7Z" fill="#7778bf"/>'
CLOUD = ('<path d="M16 38a9 9 0 0 1 1-18 13 13 0 0 1 25 1 8.5 8.5 0 0 1 2 17Z" '
         'fill="#d0dfef" stroke="#7292ac" stroke-width="1.7"/>')
PRECIPITATION = {
    '09': '<path d="m21 43-3 6m13-6-3 6m13-6-3 6" stroke="#4389c2" stroke-width="2.5" stroke-linecap="round"/>',
    '11': '<path d="m31 36-7 10h6l-2 8 11-12h-7l3-6Z" fill="#e6ac31"/>',
    '13': '<g fill="#639bc4"><circle cx="21" cy="46" r="2"/><circle cx="31" cy="49" r="2"/>'
          '<circle cx="41" cy="46" r="2"/></g>',
    '50': '<path d="M15 44h31m-25 5h20" stroke="#7292ac" stroke-width="2" stroke-linecap="round"/>',
}


def recovery_labels(highlights):
    seconds = highlights['recovery_seconds']
    kind = 'Accumulated estimate' if highlights['recovery_kind'] == 'cumulative' else 'Workout estimate'
    until = highlights['recovery_until']
    return sleep_time(seconds), kind, (f"Until {datetime.fromisoformat(until):%Y-%m-%d %H:%M}" if until else '')


def weather_icon(code):
    condition = code[:2]
    if condition not in CONDITIONS:
        return ('<path d="M8 18h30q8 0 8-6t-6-6m-32 22h40q8 0 8 7t-7 7M8 38h23" '
                'fill="none" stroke="#7292ac" stroke-width="2.5" stroke-linecap="round"/>')
    light = MOON if code.endswith('n') else SUN
    if condition == '01':
        return f'<g transform="translate(9 4)">{light}</g>'
    behind_cloud = f'<g transform="translate(2 0) scale(.76)">{light}</g>' if condition in ('02', '10') else ''
    return behind_cloud + CLOUD + PRECIPITATION.get('09' if condition == '10' else condition, '')


def weather_card(weather):
    code = weather.get('weatherIcon')
    code = code if isinstance(code, str) and len(code) == 3 and code[-1] in 'dn' else ''
    temperature = celsius_from_kelvin(weather.get('temperature'))
    humidity, wind, direction = (weather.get(key) for key in ('humidity', 'windSpeed', 'windDirection'))
    details = []
    if number(wind) and wind >= 0:
        suffix = ''
        if wind > 0 and number(direction) and 0 <= direction <= 360:
            points = ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')
            suffix = ' ' + points[int((direction + 22.5) / 45) % len(points)]
        details.append(f'Wind {wind * 3.6:.1f} km/h{suffix}')
    if number(humidity) and 0 <= humidity <= 100:
        details.append(f'Humidity {humidity:.0f}%')
    condition = CONDITIONS.get(code[:2], '')
    if temperature is None and not condition and not details:
        return None
    return ('Weather', value(temperature, ' °C', 1) if temperature is not None else condition or 'Conditions',
            condition if temperature is not None else '', ' · '.join(details), 'weather', weather_icon(code))


def post_workout_hr(cloud):
    hr = (cloud.get('summary') or {}).get('heartRateRecovery')
    if not isinstance(hr, dict):
        return None
    rating, drop = hr.get('comparisonLevel'), hr.get('drop')
    if isinstance(rating, str) and rating in HR_RATINGS and number(drop):
        change = f'{drop:+g}'.replace('-', '−') if drop else '0'
        return f'{change} bpm', rating, HR_RATINGS[rating]
    return '—', '', 'unknown'


def workout_tiles_svg(cloud, highlights):
    cards = []
    temperature = highlights['temperature_c']
    if temperature is not None:
        shown = round(temperature, 1)
        palette, label = ('cold', 'Cold') if shown < 10 else ('hot', 'Hot') if shown >= 30 else ('mild', 'Mild')
        cards.append(('Average workout temperature', value(shown, ' °C', 1), 'Watch sensor', label, palette, ''))
    weather = weather_card(cloud.get('weather') or {})
    if weather is not None:
        cards.append(weather)
    hr = post_workout_hr(cloud)
    if hr is not None:
        change, rating, palette = hr
        source = 'Suunto comparison' if rating else 'No rated result from Suunto'
        cards.append(('Post-workout HR change', change, source, rating, palette, ''))
    if highlights['recovery_seconds'] is not None:
        duration, kind, until = recovery_labels(highlights)
        cards.append(('Recovery time', duration, until, f'Suunto · {kind.lower()}', 'recovery', ''))
    if not cards:
        return [], 0

    out = ['<g data-section="workout-tiles">']
    width = min(260, (PLOT_WIDTH - 10 * (len(cards) - 1)) / len(cards))
    for index, (name, main, detail, footer, palette, icon) in enumerate(cards):
        x = LEFT + index * (width + 10)
        background, foreground, border = PALETTES[palette]
        out.extend([f'<g data-workout-tile="{escape(name)}" data-status="{palette}" transform="translate({x:g} 95)">',
                    f'<rect width="{width:g}" height="116" rx="9" fill="{background}" stroke="{border}"/>',
                    f'<text x="14" y="24" font-size="13" fill="#526170">{escape(name)}</text>',
                    f'<text x="14" y="56" font-size="24" font-weight="bold" fill="{foreground}">{escape(main)}</text>'])
        if detail:
            out.append(f'<text x="14" y="79" font-size="13" fill="#526170">{escape(detail)}</text>')
        if footer:
            out.append(f'<text x="14" y="101" font-size="12" font-weight="bold" fill="{foreground}">{escape(footer)}</text>')
        if icon:
            out.append(f'<g data-weather-icon="" aria-hidden="true" transform="translate({width - 73:g} 17)">{icon}</g>')
        out.append('</g>')
    out.append('</g>')
    return out, 141
