"""Read available comparison summaries without contacting the network."""

import json
from datetime import datetime, timedelta

from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.downloads.workouts import workout_records
from suunto_cloud.timezones import resolve_timezone


def comparison_workouts(project, cloud, previous=None):
    rows = list(((previous or {}).get('week') or {}).get('sessions') or [])
    start = datetime.fromisoformat(cloud['start_local'])
    monday = start.date() - timedelta(days=start.weekday())
    reports = project / 'reports'
    for offset in range(7):
        for path in sorted(reports.glob(f'suunto-{monday + timedelta(days=offset)}-??????.json')):
            try:
                report = json.loads(path.read_text())
                if isinstance(report.get('cloud'), dict):
                    rows.append(report['cloud'])
            except (OSError, ValueError, TypeError):
                continue
    cached = project / 'suunto-cloud' / '.local' / 'workouts.json'
    if cached.is_file():
        name = cloud.get('timezone')
        zone = resolve_timezone(name) if name and name != 'system local' else start.tzinfo
        try:
            records = workout_records(json.loads(cached.read_text()))
            for record in records:
                try:
                    rows.append(cloud_metrics(record, zone))
                except (KeyError, TypeError, ValueError, OverflowError):
                    continue
        except (OSError, ValueError, TypeError):
            pass  # Saved summaries remain useful when the optional list cache is unavailable.
    return rows
