import { number } from '../analysis/metrics.mjs';
import { amount, clock, escape, fixed } from './format.mjs';
import { recoveryLabels } from './workout_tiles.mjs';

export const pace = value => number(value) ? clock(value) + '/km' : '—';

export function summaryObservations(context) {
  const row = context.workout;
  const km = number(row.distance_m) ? row.distance_m / 1000 : null;
  const facts = [`${amount(km, 2)} km in ${clock(row.active_seconds)} of active time ` +
    `(${pace(row.pace_seconds_per_km)}), with average / maximum heart rate ` +
    `${amount(row.avg_hr_bpm, 0)} / ${amount(row.max_hr_bpm, 0)} bpm.`];
  const metrics = [];
  if (number(row.ascent_m)) metrics.push(`${amount(row.ascent_m, 0)} m ascent`);
  if (number(row.hr_tss)) metrics.push(`HR-TSS ${amount(row.hr_tss)}`);
  if (number(context.pte)) metrics.push(`PTE ${amount(context.pte)}`);
  if (metrics.length) facts.push(metrics.join('; ') + '.');
  const pattern = context.split_pattern;
  if (pattern) {
    const [fast, slow] = [pattern.fast_pace_range, pattern.slower_pace_range];
    facts.push(`The kilometre splits show ${pattern.count} faster 1 km segments ` +
      `at ${clock(fast[0])}–${pace(fast[1])}, alternating with slower kilometres ` +
      `at ${clock(slow[0])}–${pace(slow[1])}. Terrain may influence these pace differences.`);
  } else {
    const intensity = context.intensity;
    const classified = intensity.classified_seconds;
    if (classified && intensity.easy_seconds / classified >= .9) facts.push('Most classified heart-rate time was in zones 1–2.');
    else if (classified && intensity.high_seconds / classified >= .2) {
      facts.push(`Recorded time in heart-rate zones 4–5 was ${clock(intensity.high_seconds)}.`);
    }
  }
  if ([1, 2, 3, 4, 5].includes(context.feeling)) facts.push(`Recorded workout feeling: ${amount(context.feeling, 0)}/5.`);
  const highlights = context.highlights ?? {};
  if (number(highlights.temperature_c)) facts.push(`Average workout temperature: ${fixed(highlights.temperature_c, 1)} °C (watch sensor).`);
  if (highlights.recovery_seconds != null) {
    const [estimate, kind, until] = recoveryLabels(highlights);
    facts.push(`Suunto recovery time: ${estimate} (${kind.toLowerCase()})${until ? ' · ' + until : ''}.`);
  }
  return facts;
}

export function summaryHtml(context) {
  const { workout, week } = context;
  const { comparable, group, totals, ranks } = week;
  const count = comparable.length;
  const comparisons = [];
  if (ranks.distance_m) comparisons.push(ranks.distance_m === 'highest' ? 'was the longest session' : 'was joint longest by distance');
  if (ranks.hr_tss) comparisons.push(ranks.hr_tss === 'highest' ? 'had the highest HR-TSS' : 'had joint highest HR-TSS');
  let comparison = comparisons.length
    ? `This workout ${comparisons.join(' and ')} among ${count} available ${group.toLowerCase()} sessions.`
    : count < 2 ? 'No other comparable session is available for this week.' :
      `Compared with the other ${group.toLowerCase()} sessions recorded this week:`;
  if (number(week.load_share_percent) && count > 1) {
    comparison += ` It contributed ${fixed(week.load_share_percent)}% of their combined HR-TSS.`;
  }
  const rows = comparable.map(row => {
    const local = new Date(row.start_local.slice(0, 10) + 'T00:00:00Z');
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' })
      .format(local).replace(',', '');
    const selected = row.workout_key === workout.workout_key && row.start_local === workout.start_local;
    const values = [day, row.activity, amount(number(row.distance_m) ? row.distance_m / 1000 : null, 2),
      clock(row.active_seconds), pace(row.pace_seconds_per_km), amount(row.avg_hr_bpm, 0), amount(row.hr_tss)];
    return `<tr class="${selected ? 'selected-workout' : ''}">${values.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`;
  });
  const km = number(totals.distance_m) ? totals.distance_m / 1000 : null;
  const load = amount(totals.hr_tss) + (totals.hr_tss_count === count ? '' : ` (${totals.hr_tss_count}/${count} sessions)`);
  const others = week.other.map(row => `${row.group}: ${row.count} sessions` +
    (number(row.distance_m) ? `, ${fixed(row.distance_m / 1000, 2)} km.` : '.')).join(' ');
  const facts = summaryObservations(context).map(fact => `<p>${escape(fact)}</p>`).join('');
  return `<section class="workout-summary" aria-label="Workout summary and weekly comparison">
<article><h2>Workout summary</h2>${facts}</article>
<article><h2>This week <span>${escape(week.from)} – ${escape(week.to)}</span></h2>
<p>${escape(comparison)}</p>
<div class="week-totals">
<div><strong>${amount(km, 2)} km</strong><span>${escape(group)} · ${count} sessions</span></div>
<div><strong>${clock(totals.active_seconds)}</strong><span>Active time</span></div>
<div><strong>${escape(load)}</strong><span>HR-TSS</span></div>
</div>
<div class="week-table"><table><thead><tr><th>Date</th><th>Activity</th><th>km</th><th>Active</th>
<th>Pace</th><th>Avg HR</th><th>HR-TSS</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
${others ? `<p class="other-activity">Other activity: ${escape(others)}</p>` : ''}
<p class="comparison-note">${escape(week.coverage)}</p>
</article></section>`;
}
