import { escape, fixed } from './format.mjs';
import { recoveryCharts, statusColors } from './recovery_charts.mjs';

const value = (number, unit = '', digits = 0) => number == null ? '—' : fixed(number, digits) + unit;
const localLabel = time => time.slice(0, 16).replace('T', ' ');
const nightLabel = night => `${localLabel(night.start)} – ${localLabel(night.end)}`;

function sleepTime(seconds) {
  if (seconds == null) return '—';
  const minutes = Number(fixed(seconds / 60));
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function workoutFeeling(raw) {
  if (!Number.isInteger(raw) || raw < 1 || raw > 5) return { rating: null, status: 'unknown', label: 'No rating' };
  const [status, label] = raw >= 4 ? ['green', 'High rating'] : raw === 3 ?
    ['yellow', 'Neutral rating'] : ['red', 'Low rating'];
  return { rating: raw, status, label };
}

function tiles(cards) {
  const width = Math.min(207, (1075 - 10 * (cards.length - 1)) / cards.length);
  return cards.flatMap(([label, main, detail, status, custom], index) => {
    const x = 85 + index * (width + 10);
    const [background, foreground, border, caption] = statusColors[status];
    return [
      `<g data-tile="${index}" data-status="${status}"><title>${escape(label)}: ${custom || caption}</title>`,
      `<rect x="${fixed(x, 2)}" y="151" width="${fixed(width, 2)}" height="112" rx="8" fill="${background}" stroke="${border}"/>`,
      `<text x="${fixed(x + 12, 2)}" y="174" font-size="13" fill="#526170">${escape(label)}</text>`,
      `<text x="${fixed(x + 12, 2)}" y="205" font-size="22" font-weight="bold">${escape(main)}</text>`,
      `<text x="${fixed(x + 12, 2)}" y="228" font-size="12" fill="#526170">${escape(detail)}</text>`,
      `<text x="${fixed(x + 12, 2)}" y="250" font-size="12" font-weight="bold" fill="${foreground}">${custom || caption}</text></g>`,
    ];
  });
}

export function recoveryHeader(context, feeling, tileOffset) {
  const { rating, status, label } = workoutFeeling(feeling);
  const feelingCard = ['Workout feeling', rating === null ? '—' : `${rating}/5`,
    rating === null ? 'Not recorded in Suunto' : 'Recorded after workout', status, label];
  if (!context && rating === null) return null;
  const night = context?.before;
  const header = ['<g data-section="pre-workout-recovery">',
    '<text x="85" y="109" font-size="20" font-weight="bold">Recovery &amp; workout feeling</text>'];
  let lines, height;
  if (!night) {
    const caption = context ? 'No completed sleep within 24 h before workout start.' :
      'Subjective rating recorded in Suunto after the workout.';
    lines = [...header, `<text x="85" y="135" font-size="15" fill="#526170">${caption}</text>`,
      ...tiles([feelingCard]),
      '<text x="85" y="286" font-size="13" fill="#526170">Feeling colors: 4–5 green, 3 yellow, 1–2 red; missing ratings stay gray.</text>', '</g>'];
    height = 264;
  } else {
    const { hrv_7d: week, reference_60d: reference, statuses = {} } = context;
    const cards = [
      ['Nightly HRV', value(night.hrv_ms, ' ms'), `${value(night.hrv_sample_count)} samples`, statuses.hrv_ms ?? 'unknown'],
      ['7-day average HRV', value(week.average_ms, ' ms', 1), `${week.night_count}/7 nights · calculated`, statuses.hrv_7d ?? 'unknown'],
      ['60-day HRV reference', reference ? `${value(reference.low_ms)}–${value(reference.high_ms)} ms` : 'No reference',
        reference ? `median ${value(reference.median_ms)} ms · ${reference.night_count} nights` :
          `${context.reference_night_count}/14 required nights`, 'reference'],
      ['Sleep before workout', sleepTime(night.sleep_seconds), `quality ${value(night.quality_score)}/100`, statuses.sleep ?? 'unknown'],
      ['Average overnight HR', value(night.hr_avg_bpm, ' bpm'), `minimum ${value(night.hr_min_bpm)} bpm`, statuses.hr_avg_bpm ?? 'unknown'],
      feelingCard,
    ];
    const note = reference ? 'Calculated reference: central 80% of the preceding 60 days; selected night excluded. Not the Suunto normal range.' :
      'Insufficient history for a reference. The 7-day average requires at least 3 nights.';
    const chart = recoveryCharts(context);
    lines = [...header, `<text x="85" y="135" font-size="15" fill="#526170">Sleep: ${escape(nightLabel(night))}</text>`,
      `<text x="1160" y="135" text-anchor="end" font-size="15" fill="#526170">Highest overnight SpO₂: ${value(night.spo2_max_pct, '%', 1)}</text>`,
      ...tiles(cards),
      '<text x="85" y="286" font-size="13" fill="#526170">History colors: green = within reference; yellow = outside; red = large deviation. Feeling: 4–5 green, 3 yellow, 1–2 red.</text>',
      `<text x="85" y="307" font-size="13" fill="#526170">${escape(note)}</text>`, '</g>', ...chart.lines];
    height = chart.height;
  }
  return { lines: tileOffset ? [`<g transform="translate(0 ${tileOffset})">`, ...lines, '</g>'] : lines, height, context };
}

export function recoveryMarkdown(context) {
  if (!context) return [];
  const { before: night, after, hrv_7d: week, reference_60d: reference } = context;
  const lines = ['', '## Pre-workout recovery', ''];
  if (!night) lines.push('No completed sleep within 24 h before workout start; older nights were not substituted.');
  else {
    lines.push(`Sleep: ${nightLabel(night)}.`, '', '| Metric | Value |', '| --- | --- |',
      `| Nightly HRV | ${value(night.hrv_ms, ' ms')}; samples: ${value(night.hrv_sample_count)} |`,
      `| Highest overnight SpO₂ | ${value(night.spo2_max_pct, '%', 1)} |`,
      `| 7-day average HRV | ${value(week.average_ms, ' ms', 1)}; ${week.night_count}/7 nights |`,
      `| Sleep | ${sleepTime(night.sleep_seconds)}; quality ${value(night.quality_score)}/100 |`,
      `| Average / minimum overnight HR | ${value(night.hr_avg_bpm)} / ${value(night.hr_min_bpm)} bpm |`);
    if (reference) lines.push(`| Calculated 60-day HRV reference | ${value(reference.low_ms)}–${value(reference.high_ms)} ms; median ${value(reference.median_ms)} ms; ${reference.night_count} nights |`, '', reference.method);
    else lines.push('', `No calculated reference: ${context.reference_night_count}/14 required nights.`);
    if (week.average_ms === null) lines.push('', 'The 7-day average requires at least 3 nights with HRV.');
  }
  if (after) {
    lines.push('', '## Night after workout', '', `Sleep: ${nightLabel(after)}.`, '',
      `HRV ${value(after.hrv_ms, ' ms')}; highest overnight SpO₂ ${value(after.spo2_max_pct, '%', 1)}; sleep ${sleepTime(after.sleep_seconds)}; quality ${value(after.quality_score)}/100; average overnight HR ${value(after.hr_avg_bpm, ' bpm')}.`);
    if (context.after_hrv_change_ms != null) {
      const delta = context.after_hrv_change_ms;
      lines.push(`HRV change from the pre-workout night: ${delta >= 0 ? '+' : ''}${fixed(delta)} ms. This change alone does not establish the effect of this session.`);
    }
  }
  lines.push('', `Sleep source: ${context.source}; retrieved: ${context.retrieved_at_utc || 'not provided'}.`, context.method);
  if (context.color_method) {
    lines.push('', '### Historical comparison', '', '| Metric | Status |', '| --- | --- |');
    for (const [field, label] of [['hrv_ms', 'Nightly HRV'], ['hrv_7d', '7-day average HRV'],
      ['sleep_seconds', 'Sleep duration'], ['quality_score', 'Sleep quality'], ['hr_avg_bpm', 'Average overnight HR']]) {
      lines.push(`| ${label} | ${statusColors[context.statuses?.[field] ?? 'unknown'][3]} |`);
    }
    lines.push('', context.color_method);
  }
  return lines;
}
