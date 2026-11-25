import { useLanguage } from './i18n';
import type { Language } from './i18n';
import { providers, providerNames } from '../../shared/providers';
import type { Provider } from '../../shared/providers';
import React from 'react';
import {
  Activity, ChartNoAxesCombined, CircleAlert, Clock3, HeartPulse, ListOrdered, LoaderCircle, RefreshCw, Route, Sparkles, Timer,
} from 'lucide-react';
import type { Detail, Lap } from './api';
import { errorLabel } from './api';
import { StatePanel } from './components';
import { ChartFrame } from './ChartFrame';
import { distance, duration, missing, numeric, observationText, pace } from './format';
import type { DateLabels } from './format';

const detailMetrics = [
  { key: 'maxHr', label: 'Maksymalne tętno', unit: 'ud./min', whole: true },
  { key: 'ascentM', label: 'Suma podejść', unit: 'm', whole: true },
  { key: 'descentM', label: 'Suma zejść', unit: 'm', whole: true },
  { key: 'elapsedSeconds', label: 'Czas całkowity', format: duration },
  { key: 'pauseSeconds', label: 'Czas pauz', format: duration },
  { key: 'avgPowerW', label: 'Średnia moc', unit: 'W', whole: true },
  { key: 'maxPowerW', label: 'Maksymalna moc', unit: 'W', whole: true },
  { key: 'energyKcal', label: 'Energia', unit: 'kcal', whole: true },
  { key: 'temperatureC', label: 'Temperatura', unit: '°C' },
  { key: 'hrTss', label: 'Obciążenie (hrTSS)' },
  { key: 'recoverySeconds', label: 'Czas regeneracji', format: duration },
];

const lapColumns = [
  { label: 'Dystans', value: (lap: Lap, language: Language) => distance(lap.distanceM, language) },
  { label: 'Czas aktywny', value: (lap: Lap) => duration(lap.activeSeconds) },
  { label: 'Tempo', value: (lap: Lap) => pace(lap.paceSecondsPerKm) },
  { label: 'Śr. tętno', value: (lap: Lap, language: Language) => numeric(lap.avgHr, language === 'pl' ? 'ud./min' : 'bpm', true, language) },
  { label: 'Maks. tętno', value: (lap: Lap, language: Language) => numeric(lap.maxHr, language === 'pl' ? 'ud./min' : 'bpm', true, language) },
  { label: 'Śr. moc', value: (lap: Lap, language: Language) => numeric(lap.avgPowerW, 'W', true, language) },
  { label: 'Podejścia', value: (lap: Lap, language: Language) => numeric(lap.ascentM, 'm', true, language) },
];

function Laps({ laps }: { laps: Lap[] }) {
  const { language, t } = useLanguage();
  if (!laps.length) return null;
  const columns = lapColumns.filter((column) => laps.some((lap) => column.value(lap, language) !== missing));

  return (
    <section className="panel" aria-labelledby="lap-heading">
      <div className="panel__header">
        <h2 id="lap-heading"><ListOrdered size={20} aria-hidden="true" />{t("Okrążenia")}</h2>
        <span className="muted">{laps.length}</span>
      </div>
      <div className="laps-scroll" tabIndex={0} role="region" aria-label={t("Tabela okrążeń")}>
        <table className="laps-table">
          <thead><tr><th scope="col">{t("Okrążenie")}</th>{columns.map((column) => (
            <th scope="col" key={column.label}>{t(column.label)}</th>
          ))}</tr></thead>
          <tbody>{laps.map((lap) => (
            <tr key={lap.index}><th scope="row">{lap.index}</th>{columns.map((column) => (
              <td key={column.label}>{column.value(lap, language)}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

type InterpretationActions = {
  interpretationAvailability?: Record<Provider, boolean>;
  openProviderSettings: (provider: Provider) => void;
  pending: string | null;
  interpret: (provider: Provider) => void;
};

function ProviderInterpretation({ provider, workout, dates, interpretationAvailability, openProviderSettings, pending, interpret }:
  InterpretationActions & { provider: Provider; workout: Detail; dates: DateLabels }) {
  const { t } = useLanguage();
  const name = providerNames[provider];
  const available = interpretationAvailability?.[provider] ?? false;
  const { status, result, error } = workout.interpretations[provider];
  const loading = status === 'queued' || status === 'running' || pending === `interpret-${provider}`;
  const failed = status === 'failed';

  return (
    <section className="interpretation__provider" aria-labelledby={`interpretation-${provider}`}>
      <div className="interpretation__header">
        <h3 id={`interpretation-${provider}`}>{name}</h3>
        {available ? <button
          type="button" className="button" onClick={() => interpret(provider)}
          disabled={Boolean(pending) || loading || workout.status !== 'ready'}
        >
          {loading && <LoaderCircle className="spinning" size={17} aria-hidden="true" />}
          {t(loading ? 'Interpretacja w toku…' : failed ? 'Ponów interpretację' :
            result?.stale ? 'Zaktualizuj interpretację' : result ? 'Wygeneruj ponownie' : 'Zinterpretuj trening')}
        </button> : <button type="button" className="button" onClick={() => openProviderSettings(provider)}>
          {t('Ustawienia {provider}', { provider: name })}
        </button>}
      </div>
      {loading && <p className="muted" role="status">{t('Opis pojawi się po zakończeniu zadania.')}</p>}
      {failed && <p className="text-error" role="alert">{t(errorLabel(error || 'Nie udało się przygotować interpretacji.'))}</p>}
      {result && <>
        <p className="interpretation__meta">
          <time dateTime={new Date(result.createdAt).toISOString()}>{dates.dateTime(result.createdAt)}</time>
          {result.stale && <span className="interpretation__stale">{t('Poprzednia wersja analizy')}</span>}
        </p>
        <p className="interpretation__text">{result.text}</p>
      </>}
      <p className="muted interpretation__hint">{t(available
        ? 'Po kliknięciu wybrane metryki i okrążenia trafią do {provider}. Plik FIT, GPS i dane konta pozostaną lokalnie.'
        : 'Dodaj klucz API {provider}, aby generować interpretacje treningów.', { provider: name })}</p>
    </section>
  );
}

export function WorkoutDetail({ workout, dates, retry, ...interpretationActions }:
  InterpretationActions & { workout: Detail; dates: DateLabels; retry: () => void }) {
  const { pending } = interpretationActions;
  const { language, t } = useLanguage();
  const metrics = workout.metrics;
  const cards = [
    { label: 'Dystans', value: distance(workout.distanceM, language), Icon: Route },
    { label: 'Czas aktywny', value: duration(workout.activeSeconds), Icon: Clock3 },
    { label: 'Średnie tętno', value: numeric(workout.avgHr, t('ud./min'), true, language), Icon: HeartPulse },
    { label: 'Średnie tempo', value: pace(metrics.paceSecondsPerKm), Icon: Timer },
  ];
  const readings = detailMetrics.map(({ key, label, unit, whole, format }) => ({
    label, value: format ? format(metrics[key]) : numeric(metrics[key], t(unit ?? ''), whole, language),
  }));
  readings.push({
    label: 'Średnia kadencja',
    value: numeric(metrics.avgCadence, t(metrics.cadenceUnit === 'rpm' ? 'obr./min' : 'kroków/min'), true, language),
  });
  const available = readings.filter(({ value }) => value !== missing);
  const hasAnalysis = workout.status === 'ready' || workout.chart || workout.laps.length > 0 || available.length > 0;

  return (
    <>
      <dl className="metric-cards" aria-label={t("Podstawowe metryki")}>
        {cards.map(({ label, value, Icon }) => (
          <div className="metric-card" key={label}>
            <dt><Icon size={18} aria-hidden="true" />{t(label)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {['queued', 'running'].includes(workout.status) && <StatePanel icon={workout.status === 'running'
        ? <LoaderCircle className="spinning" size={23} aria-hidden="true" /> : <Clock3 size={23} aria-hidden="true" />}
        title={workout.status === 'queued' ? 'Trening czeka na analizę' : 'Analiza jest w toku'}>
        <p>{t("Wyniki zaktualizują się po zakończeniu pracy.")}</p>
      </StatePanel>}
      {workout.status === 'failed' && <StatePanel icon={<CircleAlert size={23} aria-hidden="true" />} title={t("Nie udało się przeanalizować treningu")}>
        {workout.error && <p>{t(errorLabel(workout.error))}</p>}
        <button type="button" className="button" disabled={Boolean(pending)} onClick={retry}>
          {pending === 'retry' ? <LoaderCircle className="spinning" size={17} aria-hidden="true" />
            : <RefreshCw size={17} aria-hidden="true" />}
          {t(pending === 'retry' ? 'Zlecanie analizy…' : 'Ponów analizę')}
        </button>
      </StatePanel>}

      {hasAnalysis && <>
        <section className="panel" aria-labelledby="chart-heading">
          <div className="panel__header"><h2 id="chart-heading"><ChartNoAxesCombined size={21} aria-hidden="true" />{t("Wykresy")}</h2></div>
          {workout.chart ? <ChartFrame key={workout.deviceModel ?? ''} title={t("Interaktywne wykresy treningu")}
            src={`/api/workouts/${encodeURIComponent(workout.id)}/chart?lang=${language}&embed=1&revision=${workout.analysisVersion}`} /> :
            <div className="panel__body"><p className="muted">{t("W danych tej aktywności brakuje pomiarów do wyświetlenia wykresów.")}</p></div>}
        </section>
        {(available.length > 0 || workout.observations.length > 0) && <section className="panel" aria-labelledby="metrics-heading">
          <div className="panel__header"><h2 id="metrics-heading"><Activity size={21} aria-hidden="true" />{t("Pomiary i obserwacje")}</h2></div>
          <div className="panel__body">
            {available.length > 0 && <dl className="reading-grid">{available.map(({ label, value }) => (
              <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>
            ))}</dl>}
            {workout.observations.length > 0 && <ul className="observations">{workout.observations.map((line, index) => (
              <li key={index}>{observationText(line, language)}</li>
            ))}</ul>}
          </div>
        </section>}
        <Laps laps={workout.laps} />
        <section className="panel interpretation" aria-labelledby="interpretation-heading">
          <div className="panel__header">
            <h2 id="interpretation-heading"><Sparkles size={20} aria-hidden="true" />{t('Interpretacja')}</h2>
          </div>
          <div className="panel__body interpretation__providers">
            {providers.map((provider) => <ProviderInterpretation key={provider} provider={provider}
              workout={workout} dates={dates} {...interpretationActions} />)}
          </div>
        </section>
      </>}
    </>
  );
}
