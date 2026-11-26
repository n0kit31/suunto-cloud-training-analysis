// Suunto App IDs are distinct from FIT sport IDs.
const activityNames = {
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
};
const subSports = {
  'running:trail': 'Trail running', 'running:treadmill': 'Treadmill running',
  'cycling:mountain': 'Mountain biking', 'cycling:indoor_cycling': 'Indoor cycling',
  'cycling:gravel_cycling': 'Gravel cycling', 'swimming:open_water': 'Open-water swimming',
  'fitness_equipment:indoor_rowing': 'Indoor rowing', 'training:strength_training': 'Strength training',
};
const running = new Set([1, 22, 53, 103, 115]);
const walking = new Set([0, 11, 24, 70]);

export function footActivity(cloud, sport) {
  if (running.has(cloud.activity_id) || sport === 'running') return 'running';
  if (walking.has(cloud.activity_id) || sport === 'walking' || sport === 'hiking') return 'walking';
  return null;
}

function readableName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ').replaceAll('_', ' ').trim().replace(/\s+/g, ' ');
  return name ? [...(name[0].toUpperCase() + name.slice(1).toLowerCase())].slice(0, 40).join('') : null;
}

export function activityLabel(cloud, decoded = {}) {
  const cloudLabel = Number.isInteger(cloud.activity_id) ? activityNames[cloud.activity_id] : null;
  const label = cloudLabel ?? readableName(cloud.activity_name);
  if (label) return label;
  const sessions = decoded.sessions ?? [];
  const valid = ({ sport }) => typeof sport === 'string' && !['generic', 'unknown', 'invalid'].includes(sport);
  if (new Set(sessions.filter(valid).map(({ sport }) => sport)).size > 1) return 'Multisport';
  const session = sessions.find(valid);
  return session ? subSports[`${session.sport}:${session.sub_sport}`] ?? readableName(session.sport) : null;
}
