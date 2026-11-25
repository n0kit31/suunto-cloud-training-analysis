import React from 'react';
import type { ReactNode } from 'react';
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
  const key = normalizeSport(sport);
  if (/\btrail run(?:ning)?\b|\bbieg (?:terenowy|górski)\b/.test(key)) {
    return <span className="sport-icon sport-icon--trail"><TrailRunningIcon /></span>;
  }
  const Icon = activityIcon(key);
  return <span className="sport-icon"><Icon size={20} aria-hidden="true" /></span>;
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
