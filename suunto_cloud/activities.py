"""English activity labels; Suunto App IDs are distinct from FIT sport IDs.

Source: https://aspartnercontent.blob.core.windows.net/apizone/docs/Activities.pdf
"""

import re


ACTIVITY_NAMES = {
    0: 'Walking', 1: 'Running', 2: 'Cycling', 3: 'Cross-country skiing',
    10: 'Mountain biking', 11: 'Hiking', 12: 'Roller skating', 13: 'Downhill skiing',
    14: 'Paddling', 15: 'Rowing', 21: 'Swimming', 22: 'Trail running',
    23: 'Gym', 24: 'Nordic walking', 29: 'Climbing', 30: 'Snowboarding',
    31: 'Ski touring', 32: 'Fitness class', 51: 'Yoga / Pilates',
    52: 'Indoor cycling', 53: 'Treadmill running', 54: 'CrossFit',
    55: 'Crosstrainer', 57: 'Indoor rowing', 58: 'Stretching',
    60: 'Orienteering', 61: 'Stand-up paddling', 65: 'Snowshoeing',
    68: 'Multisport', 70: 'Trekking', 71: 'Sailing', 72: 'Kayaking',
    73: 'Circuit training', 74: 'Triathlon', 77: 'Boxing',
    78: 'Scuba diving', 79: 'Freediving', 83: 'Mountaineering',
    85: 'Open-water swimming', 92: 'Swimrun', 93: 'Duathlon',
    94: 'Aquathlon', 95: 'Obstacle racing', 99: 'Gravel cycling',
    103: 'Track running', 104: 'Calisthenics', 105: 'E-biking',
    106: 'E-mountain biking', 107: 'Backcountry skiing', 109: 'Hand cycling',
    110: 'Splitboarding', 111: 'Biathlon', 112: 'Meditation',
    114: 'Cyclocross', 115: 'Vertical running', 116: 'Ski mountaineering',
    117: 'Skate skiing', 118: 'Classic skiing', 120: 'Pilates', 121: 'Yoga',
}

FIT_SUBSPORT_NAMES = {
    ('running', 'trail'): 'Trail running', ('running', 'treadmill'): 'Treadmill running',
    ('cycling', 'mountain'): 'Mountain biking', ('cycling', 'indoor_cycling'): 'Indoor cycling',
    ('cycling', 'gravel_cycling'): 'Gravel cycling',
    ('swimming', 'open_water'): 'Open-water swimming',
    ('fitness_equipment', 'indoor_rowing'): 'Indoor rowing',
    ('training', 'strength_training'): 'Strength training',
}


def readable_name(name):
    if not isinstance(name, str) or not name.strip():
        return None
    words = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', name.strip()).replace('_', ' ')
    return ' '.join(words.split()).capitalize()[:40]


def activity_label(cloud, decoded):
    label = ACTIVITY_NAMES.get(cloud.get('activity_id'))
    if label:
        return label
    if label := readable_name(cloud.get('activity_name')):
        return label
    sessions = decoded.get('sessions') or []
    sports = {session.get('sport') for session in sessions if isinstance(session.get('sport'), str)}
    sports -= {'generic', 'unknown', 'invalid'}
    if len(sports) > 1:
        return 'Multisport'
    for session in sessions:
        sport, sub_sport = session.get('sport'), session.get('sub_sport')
        if sport not in sports:
            continue
        return FIT_SUBSPORT_NAMES.get((sport, sub_sport)) or readable_name(sport)
    return None
