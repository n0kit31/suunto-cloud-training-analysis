"""Synthetic workout measurements shared by analysis and reporting tests."""

from datetime import datetime, timedelta, timezone


def fixture():
    origin = datetime(2026, 11, 5, 16, tzinfo=timezone.utc)
    at = lambda n: (origin + timedelta(seconds=n)).isoformat().replace('+00:00', 'Z')
    rows = []
    for n in range(150):
        work = n < 60
        rows.append({'timestamp': at(n), 'heart_rate': 160 if work else 160 - (n - 60) / 2,
                     'speed': 4 if work else 2, 'cadence': 100 if work else 90,
                     'stance_time': 210 if work else 280, 'vertical_oscillation': 60 if work else 70,
                     'altitude': 50 + n / 100, 'distance': 4 * n if work else 240 + 2 * (n - 60),
                     'estimate': 14000 + n})
    laps = [{'event': 'lap', 'lap_trigger': 'distance', 'start_time': at(0), 'timestamp': at(150),
             'total_distance': 420, 'total_timer_time': 150},
            {'event': 'workout_step', 'lap_trigger': 'fitness_equipment', 'start_time': at(0),
             'timestamp': at(60), 'total_distance': 240, 'total_timer_time': 60},
            {'event': 'workout_step', 'lap_trigger': 'fitness_equipment', 'start_time': at(60),
             'timestamp': at(150), 'total_distance': 180, 'total_timer_time': 90}]
    return {'sessions': [{'start_time': at(0), 'timestamp': at(150), 'sport': 'running'}],
            'events': [{'event': 'timer', 'event_type': 'start', 'timestamp': at(0)},
                       {'event': 'timer', 'event_type': 'stop', 'timestamp': at(150)}],
            'records': rows, 'laps': laps,
            'field_descriptions': [{'field_name': 'estimate', 'units': 's',
                                    'suuntoplus_field_label': 'Marathon time(est)'}]}


def workout(key='a' * 24, day='2026-11-11', activity=1):
    start = int(datetime.fromisoformat(day + 'T08:00:00+00:00').timestamp() * 1000)
    return {'workoutKey': key, 'activityId': activity, 'startTime': start, 'stopTime': start + 1200000,
            'totalTime': 600, 'totalDistance': 2000, 'hrdata': {'workoutAvgHR': 130, 'workoutMaxHR': 145,
                                                            'userMaxHR': 187, 'max': 187},
            'tss': {'calculationMethod': 'HR', 'trainingStressScore': 10},
            'extensions': [{'type': 'SummaryExtension', 'pte': 2, 'ascent': 12.3},
                           {'type': 'FitnessExtension', 'maxHeartRate': 187, 'estimatedVo2Max': 52}]}


def decoded():
    return {'sessions': [{'total_timer_time': 600, 'total_elapsed_time': 1200,
                          'total_distance': 2000, 'avg_heart_rate': 130, 'max_heart_rate': 145}],
            'events': [{'event': 'timer', 'event_type': kind, 'timestamp': at}
                       for kind, at in [('start', '2026-11-11T08:00:00Z'),
                                        ('stop', '2026-11-11T08:05:00Z'),
                                        ('start', '2026-11-11T08:15:00Z'),
                                        ('stop', '2026-11-11T08:20:00Z')]],
            'records': [{'timestamp': '2026-11-11T08:01:00Z', 'heart_rate': 130},
                        {'timestamp': '2026-11-11T08:10:00Z', 'heart_rate': 180},
                        {'timestamp': '2026-11-11T08:16:00Z', 'heart_rate': 145}]}
