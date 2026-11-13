"""Shared time zone validation and conversions, independent of configuration storage."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class TimeZoneError(ValueError):
    pass


def resolve_timezone(name):
    if name is None or name == '':
        return None  # datetime.astimezone(None) uses system rules for the target date.
    if not isinstance(name, str):
        raise TimeZoneError('The timezone setting must be an IANA time zone name or null.')
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise TimeZoneError('Unknown time zone. Use an IANA name such as America/New_York.') from None


def local_timestamp(timestamp, zone=None):
    return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(zone)


def timezone_name(zone):
    return getattr(zone, 'key', None) or 'system local'
