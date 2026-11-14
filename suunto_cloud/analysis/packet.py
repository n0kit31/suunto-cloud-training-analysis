"""Small analysis input assembled from fresh Cloud summaries and decoded FIT."""

from suunto_cloud.timezones import local_timestamp, timezone_name


def cloud_metrics(workout, zone=None):
    extensions = {item['type']: item for item in workout.get('extensions', [])}
    summary = extensions.get('SummaryExtension', {})
    distance = workout.get('totalDistance')
    duration = workout.get('totalTime')
    start, stop = workout.get('startTime'), workout.get('stopTime')
    hr = workout.get('hrdata') or {}
    return {
        'workout_key': workout['workoutKey'],
        'activity_id': workout.get('activityId'),
        'timezone': timezone_name(zone),
        'start_local': local_timestamp(start / 1000, zone).isoformat(),
        'stop_local': local_timestamp(stop / 1000, zone).isoformat() if stop is not None else None,
        'distance_m': distance,
        'active_seconds': duration,
        'elapsed_seconds': (stop - start) / 1000 if stop is not None else None,
        'pace_seconds_per_km': duration / (distance / 1000) if distance and duration is not None else None,
        'avg_hr_bpm': hr.get('workoutAvgHR'),
        'max_hr_bpm': hr.get('workoutMaxHR'),
        'ascent_m': summary.get('ascent', workout.get('totalAscent')),
        'descent_m': summary.get('descent', workout.get('totalDescent')),
        'steps': workout.get('stepCount'),
        'energy_kcal': workout.get('energyConsumption'),
        'tss': workout.get('tss'),
        'alternative_tss': workout.get('tssList', []),
        'tags': workout.get('suuntoTags', []),
        'summary': {key: value for key, value in summary.items()
                    if value is not None and key not in
                    {'type', 'gear', 'additionalGears', 'exerciseId', 'apps', 'weather'}},
        'fitness': extensions.get('FitnessExtension'),
        'intensity': extensions.get('IntensityExtension'),
        'weather': extensions.get('WeatherExtension'),
        'suuntoplus_apps': summary.get('apps', []),
        'zone_sense': workout.get('zoneSense'),
        'rankings': workout.get('rankings'),
    }


def compact_fit(analysis):
    """Retain laps and pauses; keep unbounded peak samples in the full analysis file."""
    peaks = analysis.get('hr_peak_records_active_only', [])
    return {
        **{key: value for key, value in analysis.items()
           if key != 'hr_peak_records_active_only'},
        'hr_peak': {
            'sample_count': len(peaks),
            'first': peaks[0] if peaks else None,
            'last': peaks[-1] if peaks else None,
            'samples_preview': peaks[:5],
        },
    }


def build_packet(manifest, records, analyses, zone=None):
    by_key = {workout['workoutKey']: workout for workout in records}
    selected = [by_key[entry['workout_key']] for entry in manifest['workouts']]
    workouts = []
    for entry in manifest['workouts']:
        key = entry['workout_key']
        fit = compact_fit(analyses[key])
        details = fit.get('additional_metrics', {})
        indices = details.get('preferred_lap_indices', [lap['index'] for lap in fit.get('laps', [])])
        blocks = distance_blocks([lap for lap in fit.get('laps', []) if lap['index'] in indices],
                                 {s['lap_index']: s for s in details.get('lap_samples', [])})
        workouts.append({
            'cloud': cloud_metrics(by_key[key], zone),
            'fit': fit,
            'distance_blocks': blocks,
            'recovery': entry.get('recovery'),
            'files': {field: entry[field] for field in
                      ('cloud_summary_path', 'fit_path', 'decoded_path', 'analysis_path')},
            **({'outputs': entry['outputs']} if 'outputs' in entry else {}),
        })
    comparisons = []
    for activity_id in sorted({w.get('activityId') for w in selected if w.get('activityId') is not None}):
        before = min(w['startTime'] for w in selected if w.get('activityId') == activity_id)
        candidates = sorted((w for w in records if w.get('activityId') == activity_id
                             and w['startTime'] < before), key=lambda w: w['startTime'], reverse=True)
        comparisons.extend(cloud_metrics(w, zone) for w in candidates[:3])
    return {
        'retrieved_at_utc': manifest['retrieved_at_utc'],
        'requested_dates': manifest['requested_dates'],
        'timezone': timezone_name(zone),
        'complete': manifest['complete'],
        'workout_keys': [entry['workout_key'] for entry in manifest['workouts']],
        'cloud_packet_count': len(records),
        'history_completeness_verified': False,
        'workouts': workouts,
        'comparison_candidates': comparisons,
    }


def distance_blocks(laps, samples):
    """Aggregate complete kilometre laps without splitting or inventing observations."""
    if len(laps) < 10 or any(abs((lap.get('distance_m') or 0) - 1000) > 0.01
                             for lap in laps[:-1]):
        return None
    last = laps[-1].get('distance_m') or 0
    if not 0 < last <= 1000.01 or any(not lap.get('active_seconds') for lap in laps):
        return None
    full = laps if abs(last - 1000) <= 0.01 else laps[:-1]

    def block(rows):
        duration = sum(lap['active_seconds'] for lap in rows)
        distance = sum(lap['distance_m'] for lap in rows)
        result = {'first_lap': rows[0]['index'], 'last_lap': rows[-1]['index'],
                  'distance_m': distance, 'active_seconds': duration,
                  'pace_seconds_per_km': duration * 1000 / distance}
        for source, target in [('avg_hr', 'avg_hr_bpm'), ('avg_power_w', 'avg_power_w')]:
            available = [lap for lap in rows if isinstance(lap.get(source), (int, float))]
            covered = sum(lap['active_seconds'] for lap in available)
            result[target] = sum(lap[source] * lap['active_seconds'] for lap in available) / covered if covered else None
            result[target + '_coverage'] = covered / duration
        observations = [samples.get(lap['index'], {}) for lap in rows]
        result['mechanics'] = {}
        for field in ('cadence_steps_per_min', 'ground_contact_ms',
                      'vertical_oscillation_cm', 'estimated_step_length_m'):
            available = [(s['mechanics'][field], s.get('mechanics_paired_count', 0))
                         for s in observations if s.get('mechanics', {}).get(field) is not None]
            count = sum(n for _, n in available)
            result['mechanics'][field] = sum(value * n for value, n in available) / count if count else None
        return result

    half = len(full) // 2
    result = {'method': 'Disjoint selected kilometre laps; HR/power weighted by active lap time, '
              'mechanics by joint sample counts. Missing values excluded with coverage; no interpolation. '
              'Equal parts cover whole kilometres, not official race halves; not a formal drift test.',
              'five_km': [block(laps[i:i + 5]) for i in range(0, len(laps), 5)],
              'equal_parts': [block(full[:half]), block(full[half:2 * half])],
              'remainder': block(laps[2 * half:]) if len(laps) > 2 * half else None}
    return result


def brief_packet(packet):
    """Bound the agent-facing text; full precision and source data stay on disk."""
    result = {key: value for key, value in packet.items() if key not in ('workouts', 'comparison_candidates')}
    result['view'] = 'brief-v1; full data in .local/analysis.json and output JSON reports'
    result['workouts'] = []
    columns = ['lap', 'm', 'active_s', 'pace_s_per_km', 'hr_avg', 'hr_max', 'power_w',
               'ascent_m', 'descent_m', 'cadence_steps_min', 'contact_ms', 'oscillation_cm',
               'estimated_step_m', 'mechanics_samples', 'active_records']
    for workout in packet['workouts']:
        cloud, fit = workout['cloud'], workout['fit']
        details = fit.get('additional_metrics', {})
        samples = {row['lap_index']: row for row in details.get('lap_samples', [])}
        selected = details.get('preferred_lap_indices', [row['index'] for row in fit['laps']])
        selected_laps = [lap for lap in fit['laps'] if lap['index'] in selected]
        rows = []
        for lap in fit['laps']:
            if lap['index'] not in selected:
                continue
            stats = samples.get(lap['index'], {})
            mechanics = stats.get('mechanics', {})
            row = [lap['index'], lap['distance_m'], lap['active_seconds'], lap['pace_seconds_per_km'],
                   lap['avg_hr'], lap['max_hr'], lap['avg_power_w'], lap['ascent_m'], lap['descent_m'],
                   mechanics.get('cadence_steps_per_min'), mechanics.get('ground_contact_ms'),
                   mechanics.get('vertical_oscillation_cm'), mechanics.get('estimated_step_length_m'),
                   stats.get('mechanics_paired_count'), stats.get('record_count')]
            rows.append([round(v, 3) if isinstance(v, float) else v for v in row])
        core = {key: value for key, value in cloud.items()
                if key not in ('alternative_tss', 'intensity', 'summary', 'weather', 'suuntoplus_apps')}
        core['summary'] = {key: value for key, value in cloud['summary'].items()
                           if key in ('avgPower', 'maxPower', 'avgCadence', 'avgGroundContactTime',
                                      'avgVerticalOscillation', 'pte', 'peakEpoc', 'feeling', 'recoveryTime')}
        core['hr_zones'] = ((cloud.get('intensity') or {}).get('zones') or {}).get('heartRate')
        core['alternative_tss'] = [{k: v for k, v in t.items() if k in
                                   ('calculationMethod', 'trainingStressScore', 'intensityFactor', 'normalizedPower')}
                                  for t in cloud['alternative_tss']]
        core['suuntoplus_apps'] = cloud.get('suuntoplus_apps')
        result['workouts'].append({'cloud': core, 'lap_columns': columns, 'lap_rows': rows,
                                   'recovery': workout.get('recovery'),
                                   'distance_blocks': workout.get('distance_blocks') or distance_blocks(selected_laps, samples),
                                   'pauses': fit['timer']['pauses'], 'hr_peak': fit['hr_peak'],
                                   'sample_counts': {k: fit[k] for k in ('record_count', 'active_hr_sample_count',
                                                                      'rr_interval_count', 'ddfa_sample_count')},
                                   'sample_method': details.get('method'),
                                   'active_statistics': details.get('active'),
                                   'recovery_hr': details.get('slower_next_lap_hr_changes'),
                                   'suuntoplus_channels': details.get('suuntoplus_channels'),
                                   'altitude_profile': details.get('altitude_profile'),
                                   'outputs': workout.get('outputs'), 'files': workout['files']})
    result['comparison_candidates'] = [
        {key: w[key] for key in ('workout_key', 'activity_id', 'start_local', 'distance_m', 'active_seconds',
                                'pace_seconds_per_km', 'avg_hr_bpm', 'max_hr_bpm', 'ascent_m', 'tss')}
        for w in packet['comparison_candidates']]
    return result
