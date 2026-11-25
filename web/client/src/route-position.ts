export type TimedPoint = [latitude: number, longitude: number, activeTime: number | null];
export type RoutePosition = [latitude: number, longitude: number];
type Sample = [seconds: number, latitude: number, longitude: number, segment: number];

export function routeSamples(segments: TimedPoint[][]): Sample[] {
  return segments.flatMap((line, segment) => line.flatMap(([lat, lon, time]): Sample[] =>
    time === null ? [] : [[time, lat, lon, segment]],
  )).sort(([a], [b]) => a - b);
}

export function routePosition(samples: Sample[], time: number | null): RoutePosition | null {
  if (time === null) return null;
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (samples[middle][0] <= time) lo = middle + 1;
    else hi = middle;
  }
  const before = samples[lo - 1];
  const after = samples[lo];
  if (before && after && before[3] === after[3] && after[0] - before[0] <= 10) {
    const fraction = (time - before[0]) / (after[0] - before[0]);
    return [before[1] + (after[1] - before[1]) * fraction,
      before[2] + (after[2] - before[2]) * fraction];
  }
  if (before && time - before[0] <= 1) return [before[1], before[2]];
  if (after && after[0] - time <= 1) return [after[1], after[2]];
  return null;
}
