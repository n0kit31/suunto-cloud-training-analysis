import { sportLabel } from '../shared/language.ts';
import type { Language } from '../shared/language.ts';

const chartLabels: Record<string, string> = {
  'Workout chart inspector': 'Odczyt wykresów treningu',
  'Active time': 'Czas aktywny',
  'Distance': 'Dystans',
  'Move across a workout panel': 'Przesuń kursor nad wykresem',
  'Pin position': 'Przypnij pozycję',
  'Clear': 'Wyczyść',
  'Download SVG': 'Pobierz SVG',
  'Select a lap': 'Wybierz okrążenie',
  'Choose a lap': 'Wybierz okrążenie',
  'Full workout': 'Cały trening',
  'Select active time': 'Wybierz czas aktywny',
  'Selected active workout time': 'Wybrany czas aktywny treningu',
  'No position selected': 'Nie wybrano pozycji',
  'Move to inspect all workout panels.': 'Przesuwaj kursor, aby odczytywać wartości na wszystkich wykresach.',
  'Click or tap to pin; click again or press Escape to release.':
    'Kliknij lub stuknij, aby przypiąć pozycję. Kliknij ponownie lub naciśnij Escape, aby ją zwolnić.',
  'Drag across a panel to zoom or select a lap above.': 'Przeciągnij po wykresie, aby powiększyć zakres, lub wybierz okrążenie.',
  'Lap statistics use FIT lap summaries.': 'Statystyki okrążeń pochodzą z podsumowań FIT.',
  'Drag selections use recorded samples, with distance and pace measured between the first and last distance samples in the range.':
    'Statystyki zaznaczenia korzystają z zarejestrowanych próbek. Dystans i tempo liczone są między pierwszą i ostatnią próbką dystansu.',
  'Readouts follow the smoothed lines at nearby recorded times (within 1 second); gaps show “No data”.':
    'Odczyty pochodzą z wygładzonej linii w granicach jednej sekundy od kursora. Luki mają oznaczenie „Brak danych”.',
  'Sleep and HRV use their own calendar axis.': 'Sen i HRV mają osobną oś kalendarzową.',
  'The charts are visible below. Enable JavaScript for synchronized readouts.': 'Wykresy są poniżej. Włącz JavaScript, aby zsynchronizować odczyty.',
  'Workout overview': 'Przegląd treningu',
  'Time axis: active workout time': 'Oś czasu: czas aktywny treningu',
  'Workout panels: active time · Recovery panels: local wake date': 'Wykresy treningu: czas aktywny · Regeneracja: lokalna data pobudki',
  'blue bands: interval before a slower workout step': 'niebieskie pasma: odcinek przed wolniejszym etapem treningu',
  'Active workout time (min)': 'Czas aktywny treningu (min)',
  'Heart rate': 'Tętno',
  'Pace': 'Tempo',
  'Elevation': 'Wysokość',
  'm above sea level': 'm n.p.m.',
  'Running power': 'Moc biegowa',
  'Power': 'Moc',
  'Cadence': 'Kadencja',
  'Ground contact': 'Kontakt z podłożem',
  'Estimated step length': 'Szacowana długość kroku',
  'Speed': 'Prędkość',
  'Estimated terrain grade': 'Szacowane nachylenie terenu',
  '15 s moving average': 'średnia krocząca z 15 s',
  '15 s moving median': 'mediana krocząca z 15 s',
  'dots + 15 s median trend': 'punkty i mediana krocząca z 15 s',
  '50 m window + 15 s mean': 'okno 50 m i średnia z 15 s',
  'steps/min': 'kroków/min',
  'rpm': 'obr./min',
  'bpm': 'ud./min',
  'Workout step': 'Etap treningu',
  'Lap': 'Okrążenie',
  'Average workout temperature': 'Średnia temperatura podczas treningu',
  'Watch sensor': 'Czujnik zegarka',
  'Cold': 'Zimno',
  'Mild': 'Umiarkowanie',
  'Hot': 'Gorąco',
  'Weather': 'Pogoda',
  'Conditions': 'Warunki',
  'Clear sky': 'Bezchmurne niebo',
  'Partly cloudy': 'Częściowe zachmurzenie',
  'Scattered clouds': 'Rozproszone chmury',
  'Broken clouds': 'Duże zachmurzenie',
  'Showers': 'Przelotny deszcz',
  'Rain': 'Deszcz',
  'Thunderstorm': 'Burza',
  'Snow': 'Śnieg',
  'Mist': 'Mgła',
  'Wind ': 'Wiatr ',
  'Humidity ': 'Wilgotność ',
  'Post-workout HR change': 'Zmiana tętna po treningu',
  'Suunto comparison': 'Porównanie Suunto',
  'No rated result from Suunto': 'Brak oceny Suunto',
  'Excellent': 'Doskonały',
  'Normal': 'Typowy',
  'Slow': 'Wolny',
  'Recovery time': 'Czas regeneracji',
  'accumulated estimate': 'łączny szacunek',
  'workout estimate': 'szacunek po treningu',
  'Until ': 'Do ',
};

const readouts: Record<string, string> = {
  'No data': 'Brak danych',
  'Pin position': 'Przypnij pozycję',
  'Release position': 'Zwolnij pozycję',
  'Move across a workout panel': 'Przesuń kursor nad wykresem',
  'Position pinned · scroll to compare panels': 'Pozycja przypięta · przewiń, aby porównać wykresy',
  'Click or tap to pin position': 'Kliknij lub stuknij, aby przypiąć pozycję',
  'No position selected': 'Nie wybrano pozycji',
  ' (samples)': ' (próbki)',
  ' · Active ': ' · Czas aktywny ',
  ' · Pace ': ' · Tempo ',
  ' · HR avg/max ': ' · Tętno śr./maks. ',
  ' bpm · ': ' ud./min · ',
  'Power avg ': 'Średnia moc ',
};

function translator(entries: Record<string, string>) {
  const phrases = Object.keys(entries).sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
  const pattern = new RegExp(phrases.join('|'), 'g');
  return (text: string) => text.replace(pattern, (label) => entries[label]);
}

const translateLabel = translator(chartLabels);
const translateReadout = translator(readouts);
const chartDescription = 'Wykresy pokazują zarejestrowane pomiary względem aktywnego czasu treningu. '
  + 'Tętno, wysokość i moc są wygładzone średnią z 15 sekund, a tempo i prędkość medianą z 15 sekund. '
  + 'Kadencję, kontakt z podłożem i długość kroku pokazano jako punkty z trendem mediany. '
  + 'Wygładzanie uwzględnia pauzy i luki w pomiarach. Brakujące metryki są pomijane.';

function escapeText(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function presentChart(html: string, sport: string, language: Language, deviceModel: string | null) {
  // Existing web artifacts include these two script blocks. Keep the data and
  // behavior of the archived chart and translate only its presentation.
  const dataStart = html.indexOf('<script id="chart-data"');
  const dataEnd = html.indexOf('</script>', dataStart);
  if (dataStart < 0 || dataEnd < 0) return html;
  const heading = (text: string, forMarkup: boolean) => {
    if (!text.startsWith('Workout overview · ')) return language === 'pl' ? translateLabel(text) : text;
    const label = sportLabel(sport, 'pl');
    const date = text.match(/\d{4}-\d{2}-\d{2} .+$/)?.[0];
    const title = language === 'en' ? text : date
      ? `Przegląd treningu · ${forMarkup ? escapeText(label) : label} · ${date}` : translateLabel(text);
    return deviceModel ? `${title} · ${forMarkup ? escapeText(deviceModel) : deviceModel}` : title;
  };
  const prefix = html.slice(0, dataStart);
  const markup = language === 'pl' ? prefix
    .replace('<html lang="en">', '<html lang="pl">')
    .replace(/<desc id="desc">[^<]*<\/desc>/, `<desc id="desc">${chartDescription}</desc>`)
    .replace(/(aria-(?:label|valuetext))="([^"]+)"/g, (_original, name, text) => `${name}="${translateLabel(text)}"`)
    .replace(/>([^<>]+)</g, (_original, text) => `>${heading(text, true)}<`)
    : prefix.replace(/>(Workout overview · [^<>]+)</g, (_original, text) => `>${heading(text, true)}<`);
  const data = html.slice(dataStart, dataEnd).replace(/"(title|label|unit)":("(?:\\.|[^"\\])*")/g,
    (_original, key, value) => `"${key}":${JSON.stringify(heading(JSON.parse(value), false))
      .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')}`);
  const tail = html.slice(dataEnd);
  const chart = deviceModel ? markup.replace(
    /(<text\b[^>]*>)((?:Workout overview|Przegląd treningu) · [^<]*)(<\/text>)/,
    (original, start, title, end) => {
      const device = escapeText(deviceModel);
      const suffix = ` · ${device}`;
      if (!title.endsWith(suffix)) return original;
      return `${start}${title.slice(0, -suffix.length)} · <tspan aria-hidden="true" font-size="0.83em">⌚</tspan> ${device}${end}`;
    },
  ) : markup;
  return chart + data + (language === 'pl' ? translateReadout(tail) : tail);
}
