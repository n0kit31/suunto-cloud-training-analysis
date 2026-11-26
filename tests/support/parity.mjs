export function decodedCases() {
  const start = Date.parse('2026-11-05T16:00:00Z');
  const at = seconds => new Date(start + seconds * 1000).toISOString();
  const event = (kind, seconds) => ({ event: 'timer', event_type: kind, timestamp: at(seconds) });
  const lap = (from, to, distance, event, trigger) => ({
    start_time: at(from), timestamp: at(to), event, lap_trigger: trigger,
    total_distance: distance, total_timer_time: to - from, avg_heart_rate: 150, max_heart_rate: 168,
  });
  const guided = {
    sessions: [{ start_time: at(0), timestamp: at(150), sport: 'running', sub_sport: 'trail', avg_temperature: 6, recovery_time: 5400 }],
    events: [event('start', 0), event('stop_all', 150)],
    records: Array.from({ length: 150 }, (_, second) => {
      const work = second < 60;
      return {
        timestamp: at(second), heart_rate: work ? 160 : 160 - (second - 60) / 2,
        speed: work ? 4 : 2, cadence: work ? 100 : 90, stance_time: work ? 210 : 280,
        vertical_oscillation: 60, altitude: 50 + second / 100, distance: work ? 4 * second : 240 + 2 * (second - 60),
        estimate: 14000 + second, power: 235 - second % 8,
      };
    }),
    laps: [lap(0, 150, 420, 'lap', 'distance'), lap(0, 60, 240, 'workout_step', 'fitness_equipment'),
      lap(60, 150, 180, 'workout_step', 'fitness_equipment')],
    field_descriptions: [{ field_name: 'estimate', units: 's', suuntoplus_field_label: 'Marathon time(est)' }],
  };
  const cloud = {
    workoutKey: '1'.repeat(24), activityId: 22, startTime: start, stopTime: start + 150000,
    totalDistance: 420, totalTime: 150, hrdata: { workoutAvgHR: 150, workoutMaxHR: 168 },
    cumulativeRecoveryTime: 9000, tss: { calculationMethod: 'HR', trainingStressScore: 12.35 },
    extensions: [{ type: 'SummaryExtension', pte: 2.3, feeling: 4, avgTemperature: 284.15,
      heartRateRecovery: { comparisonLevel: 'Normal', drop: -21 } },
    { type: 'WeatherExtension', weatherIcon: '02d', temperature: 284.15, humidity: 83, windSpeed: 2.5, windDirection: 40 }],
  };
  const paused = structuredClone(guided);
  paused.events.push(event('stop', 90), event('stop_all', 100), event('start', 120));
  paused.records[100].heart_rate = 244;
  delete paused.records[0].cadence;
  const nordic = structuredClone(guided);
  nordic.sessions[0].sport = 'generic';
  nordic.laps = nordic.laps.slice(0, 1);
  nordic.records = nordic.records.filter((_, index) => index < 60 || index > 80);
  delete nordic.records[8].altitude;
  nordic.records[23].distance = nordic.records[22].distance;
  const empty = { sessions: [{ sport: 'running' }], records: [], events: [] };
  return {
    guided: { decoded: guided, cloud, zone: 'Europe/Warsaw' },
    paused: { decoded: paused, cloud: { ...cloud, totalTime: 120 }, zone: 'Europe/Warsaw' },
    nordic: { decoded: nordic, cloud: { ...cloud, activityId: 24 }, zone: 'America/New_York' },
    empty: { decoded: empty, cloud, zone: 'UTC' },
  };
}
