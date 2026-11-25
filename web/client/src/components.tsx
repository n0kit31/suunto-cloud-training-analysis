import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Activity, Bike, Dumbbell, Footprints, Mountain, Waves } from 'lucide-react';
import type { Workout } from './api';
import { normalizeSport } from './format';
import { useLanguage } from './i18n';

const statusLabels: Record<Workout['status'], string> = {
  queued: 'W kolejce',
  running: 'Analizowanie',
  ready: 'Gotowe',
  failed: 'Błąd analizy',
};

const activityHues = new Map([
  ['run', 255],
  ['running', 255],
  ['road running', 243],
  ['track running', 266],
  ['treadmill running', 284],
  ['vertical running', 18],
  ['walking', 39],
  ['nordic walking', 62],
  ['hiking', 143],
  ['trekking', 105],
  ['cycling', 211],
  ['biking', 211],
  ['road cycling', 220],
  ['mountain biking', 164],
  ['gravel cycling', 27],
  ['indoor cycling', 232],
  ['swimming', 183],
  ['pool swimming', 194],
  ['open water swimming', 200],
  ['strength training', 315],
  ['weight training', 315],
  ['gym', 296],
  ['fitness class', 326],
  ['cross country skiing', 225],
  ['rowing', 158],
  ['climbing', 14],
  ['triathlon', 350],
  ['multisport', 277],
]);

function activityStyle(key: string): CSSProperties {
  const knownHue = activityHues.get(key);
  if (knownHue !== undefined) return { '--sport-hue': knownHue } as CSSProperties;

  // Keep colours for additional FIT and Suunto sports independent of list order.
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return {
    '--sport-hue': ((hash >>> 0) % 36_000) / 100,
    '--sport-saturation': `${40 + ((hash >>> 24) % 33)}%`,
  } as CSSProperties;
}

function activityIcon(key: string) {
  if (/hik|trekk|wędr/.test(key)) return Mountain;
  if (/run|walk|bieg|spacer/.test(key)) return Footprints;
  if (/cycl|bik|rower|kolars/.test(key)) return Bike;
  if (/swim|pływ/.test(key)) return Waves;
  if (/train|fitness|siłow/.test(key)) return Dumbbell;
  return Activity;
}

function TrailRunningIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 17.8v-3.1a1 1 0 0 1 1.5-.9l1.1.6a3.1 3.1 0 0 0 4.1-1l3.2-4.6a1.1 1.1 0 0 1 1.7 0l4.2 4.5a4 4 0 0 0 2.1 1.2l2.9.7a3.1 3.1 0 0 1 2.4 3v1.5H6.4a1.9 1.9 0 0 1-1.9-1.9Z" />
      <path d="M5 17h21.7m-14-5.9 2.4 1.6m.2-4 2.3 1.6" />
      <circle cx="5" cy="26" r="1.2" />
      <circle cx="27" cy="23.5" r="1.2" />
      <path d="M8 26h3c3.5 0 4-2.5 7.4-2.5H24" strokeDasharray="2 2.4" />
    </svg>
  );
}

export function SportIcon({ sport }: { sport: string }) {
  const key = normalizeSport(sport).replace(/\s+/g, ' ');
  if (/\btrail run(?:ning)?\b|\bbieg (?:terenowy|górski)\b/.test(key)) {
    return <span className="sport-icon sport-icon--trail"><TrailRunningIcon /></span>;
  }
  const Icon = activityIcon(key);
  return <span className="sport-icon" style={activityStyle(key)}><Icon size={20} aria-hidden="true" /></span>;
}

export function WorkoutStatus({ status }: { status: Workout['status'] }) {
  const { t } = useLanguage();
  return <span className={`workout-status workout-status--${status}`}><span aria-hidden="true" />{t(statusLabels[status])}</span>;
}

export function SourceLabel({ source }: { source: Workout['source'] }) {
  const { t } = useLanguage();
  return source === 'fit' ? <span className="source-label">{t('Plik FIT')}</span> : null;
}

export function StatePanel({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  const { t } = useLanguage();
  return (
    <div className="state-panel">
      <span className="state-panel__icon">{icon}</span>
      <strong>{t(title)}</strong>
      {children}
    </div>
  );
}
