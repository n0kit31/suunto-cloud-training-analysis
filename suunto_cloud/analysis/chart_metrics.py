"""Derived chart measurements from observed samples, without changing source data."""

from bisect import bisect_left, bisect_right

from suunto_cloud.analysis.metrics import number


def step_length(row):
    """Single step in metres from simultaneous speed and cadence (cycles/min)."""
    speed, cadence = row.get('speed'), row.get('cadence')
    if not (number(speed) and number(cadence) and speed > 0 and cadence > 0):
        return None
    return 30 * speed / cadence


def grade_samples(rows, intervals, window_m=50, minimum_distance_m=20):
    """Local rise/run over up to ±25 m within continuous, moving observations.

    Split at pauses, gaps >2 s, missing inputs, and distance resets. Stationary
    samples have no grade estimate. Use actual endpoint observations, with at
    least 20 m of distance and three samples; no time interpolation is used.
    """
    groups, current = [], []
    interval_index = 0
    previous = None
    for when, row in rows:
        while interval_index < len(intervals) and when >= intervals[interval_index][1]:
            interval_index += 1
        distance, altitude = row.get('distance'), row.get('altitude')
        valid = (interval_index < len(intervals)
                 and intervals[interval_index][0] <= when < intervals[interval_index][1]
                 and number(distance) and number(altitude))
        if not valid:
            if current:
                groups.append(current)
            current, previous = [], None
            continue
        if previous is not None:
            old_time, old_distance, old_interval = previous
            if (interval_index != old_interval or when - old_time > 2
                    or distance < old_distance):
                if current:
                    groups.append(current)
                current = []
            elif distance == old_distance:
                if current and when - current[-1][0] > 2:
                    groups.append(current)
                    current = []
                previous = when, distance, interval_index
                continue
        current.append((when, distance, altitude))
        previous = when, distance, interval_index
    if current:
        groups.append(current)

    result = []
    for group in groups:
        distances = [d for _, d, _ in group]
        for when, distance, _ in group:
            first = bisect_left(distances, distance - window_m / 2)
            last = bisect_right(distances, distance + window_m / 2) - 1
            if last - first < 2:
                continue
            _, start_distance, start_altitude = group[first]
            _, end_distance, end_altitude = group[last]
            span = end_distance - start_distance
            if span >= minimum_distance_m:
                result.append((when, 100 * (end_altitude - start_altitude) / span))
    return result
