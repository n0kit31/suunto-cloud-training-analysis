import { lowerBound, number } from './metrics.mjs';

export function gradeSamples(rows, intervals, windowMetres = 50, minimumDistance = 20) {
  const groups = [];
  let current = [];
  let previous = null;
  let index = 0;
  const finish = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const [time, row] of rows) {
    while (index < intervals.length && time >= intervals[index][1]) index++;
    const { distance, altitude } = row;
    if (index >= intervals.length || time < intervals[index][0] || !number(distance) || !number(altitude)) {
      finish();
      previous = null;
      continue;
    }
    if (previous) {
      if (previous.index !== index || time - previous.time > 2 || distance < previous.distance) finish();
      else if (distance === previous.distance) {
        if (current.length && time - current.at(-1)[0] > 2) finish();
        previous = { time, distance, index };
        continue;
      }
    }
    current.push([time, distance, altitude]);
    previous = { time, distance, index };
  }
  finish();
  const result = [];
  for (const group of groups) {
    const distances = group.map(([, distance]) => distance);
    for (const [time, distance] of group) {
      const first = lowerBound(distances, distance - windowMetres / 2);
      const last = lowerBound(distances, distance + windowMetres / 2, true) - 1;
      if (last - first < 2) continue;
      const span = distances[last] - distances[first];
      if (span >= minimumDistance) result.push([time, 100 * (group[last][2] - group[first][2]) / span]);
    }
  }
  return result;
}
