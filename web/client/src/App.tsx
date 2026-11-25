import { useLanguage } from './i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import {
  Activity, ArrowLeft, CalendarDays, CircleAlert, Clock3, ListFilter, LoaderCircle, Mountain, RefreshCw, Route,
  Settings, Upload, Watch,
} from 'lucide-react';
import { errorLabel, messageFromError, submit, useResource } from './api';
import type { Detail, ImportResult, Status, Workout, Workouts } from './api';
import { SourceLabel, SportIcon, StatePanel, WorkoutStatus } from './components';
import { distance, duration, formatDates, missing, numeric, sportLabel } from './format';
import type { DateLabels } from './format';
import { WorkoutDetail } from './WorkoutDetail';
import { AppSettings } from './AppSettings';
import { LanguageMenu } from './LanguageMenu';
import { JobErrors } from './JobErrors';
import type { SettingsSection } from './AppSettings';
import { SyncMessage, SyncToast, syncOutcome } from './SyncToast';
import type { SyncNotice } from './SyncToast';

const pageSize = 20;
const syncNoticeStorageKey = 'suunto-web-last-sync-notice';
const noFilters = { sport: '', from: '', to: '' };

type Filters = typeof noFilters;
type Notice = { text: string; count?: number; error?: boolean; files?: ImportResult['files'] };
type Navigate = (event: MouseEvent<HTMLAnchorElement>) => void;

function useNavigation() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate: Navigate = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const next = event.currentTarget.pathname;
    if (next !== window.location.pathname) window.history.pushState(null, '', next);
    setPath(next);
  };

  return { path, navigate };
}

function workoutPath(id: string) {
  return `/workouts/${encodeURIComponent(id)}`;
}

function Header({ status, serviceDown, navigate, onSettings }: {
  status?: Status; serviceDown: boolean; navigate: Navigate; onSettings: () => void;
}) {
  const { t } = useLanguage();
  const [tone, label] = serviceDown ? ['warning', 'Brak połączenia z aplikacją'] :
    status?.authorized === true ? ['ready', 'Suunto połączone'] :
    status?.authorized === false ? ['warning', 'Połącz z Suunto'] : ['neutral', 'Sprawdzanie połączenia'];

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <a href="/" onClick={navigate} className="brand">
          <span className="brand__mark"><Mountain size={23} strokeWidth={2.2} aria-hidden="true" /></span>
          <span>Suunto Cloud</span>
        </a>
        <div className="topbar-actions">
          <LanguageMenu />
          <button type="button" className={`connection connection--${tone}`} onClick={onSettings}
            aria-label={t('Ustawienia aplikacji')} title={t('Ustawienia aplikacji')}>
            <Watch size={16} aria-hidden="true" />{t(label)}<Settings size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

function StatStrip({ total, status, dates, filtered, onErrors }: {
  total?: number; status?: Status; dates: DateLabels; filtered: boolean; onErrors: () => void;
}) {
  const { language, t } = useLanguage();
  const pending = status ? status.jobs.running + status.jobs.queued : null;
  const failures = status?.jobs.failed ?? 0;

  return (
    <div className="stat-strip" aria-label={t("Stan biblioteki")}>
      <div className="stat">
        <span className="stat__icon"><Activity size={19} aria-hidden="true" /></span>
        <div><p>{t(filtered ? 'Pasujące treningi' : 'Treningi w bibliotece')}</p><strong>{total === undefined ? missing : numeric(total, '', true, language)}</strong></div>
      </div>
      <div className="stat">
        <span className="stat__icon"><CalendarDays size={19} aria-hidden="true" /></span>
        <div>
          <p>{t('Ostatnia synchronizacja')}</p>
          <strong>{status?.lastSyncedAt ? dates.dateTime(status.lastSyncedAt) : missing}</strong>
          {status?.lastSyncResult && <details className="sync-result">
            <summary>{t('Wynik ostatniej synchronizacji')}</summary>
            <p><SyncMessage notice={syncOutcome(status.lastSyncResult)} /></p>
          </details>}
        </div>
      </div>
      <div className="stat">
        <span className="stat__icon"><Clock3 size={19} aria-hidden="true" /></span>
        <div>
          <p>{t("Zadania w kolejce lub w toku")}</p>
          <strong>{pending === null ? missing : numeric(pending, '', true, language)}</strong>
          {status && <button type="button" aria-haspopup="dialog" onClick={onErrors}
            className={`stat__failures${failures > 0 ? ' stat__failures--active' : ''}`}>
            {t('Błędy: {count}', { count: failures })}
          </button>}
        </div>
      </div>
    </div>
  );
}

function WorkoutTable({ workouts, navigate, dates }: { workouts: Workout[]; navigate: Navigate; dates: DateLabels }) {
  const { language, t } = useLanguage();
  return (
    <table className="activity-table" role="table">
      <thead role="rowgroup"><tr role="row">
        <th scope="col" role="columnheader">{t("Aktywność")}</th><th scope="col" role="columnheader">{t("Dystans")}</th>
        <th scope="col" role="columnheader">{t("Czas aktywny")}</th><th scope="col" role="columnheader">{t("Śr. tętno")}</th>
        <th scope="col" role="columnheader">Status</th>
      </tr></thead>
      <tbody role="rowgroup">
        {workouts.map((workout) => (
          <tr key={workout.id} role="row">
            <th scope="row" role="rowheader">
              <a className="activity-link" href={workoutPath(workout.id)} onClick={navigate}>
                <SportIcon sport={workout.sport} />
                <span className="activity-title">
                  <strong>{sportLabel(workout.sport, language)}</strong>
                  <time dateTime={new Date(workout.startedAt).toISOString()}>{dates.dateTime(workout.startedAt)}</time>
                </span>
              </a>
            </th>
            <td role="cell"><span className="mobile-label" aria-hidden="true">{t("Dystans")}</span>{distance(workout.distanceM, language)}</td>
            <td role="cell"><span className="mobile-label" aria-hidden="true">{t("Czas aktywny")}</span>{duration(workout.activeSeconds)}</td>
            <td role="cell"><span className="mobile-label" aria-hidden="true">{t("Śr. tętno")}</span>{numeric(workout.avgHr, t('ud./min'), true, language)}</td>
            <td role="cell" className="table-state"><WorkoutStatus status={workout.status} /><SourceLabel source={workout.source} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FilterBar({ filters, setFilters, sports }: {
  filters: Filters; setFilters: (filters: Filters) => void; sports: string[];
}) {
  const { language, t } = useLanguage();
  return (
    <div className="filters" role="group" aria-label={t("Filtry treningów")}>
      <label>
        <span>{t("Sport")}</span>
        <select value={filters.sport} onChange={(event) => setFilters({ ...filters, sport: event.target.value })}>
          <option value="">{t("Wszystkie sporty")}</option>
          {sports.map((sport) => <option key={sport} value={sport}>{sportLabel(sport, language)}</option>)}
        </select>
      </label>
      <label>
        <span>{t("Od")}</span>
        <input type="date" value={filters.from} max={filters.to || undefined}
          onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
      </label>
      <label>
        <span>{t("Do")}</span>
        <input type="date" value={filters.to} min={filters.from || undefined}
          onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
      </label>
      {(filters.sport || filters.from || filters.to) &&
        <button className="button button--quiet filters__clear" type="button" onClick={() => setFilters(noFilters)}>{t("Wyczyść")}</button>}
    </div>
  );
}

function Feedback({ notice }: { notice: Notice | null }) {
  const { t } = useLanguage();
  if (!notice) return null;
  return (
    <div className={`feedback${notice.error ? ' feedback--error' : ''}`} role={notice.error ? 'alert' : 'status'}>
      {notice.error
        ? <CircleAlert size={19} aria-hidden="true" />
        : <Activity size={19} aria-hidden="true" />}
      <div>
        <p>{t(notice.text, notice.count === undefined ? undefined : { count: notice.count })}</p>
        {notice.files?.length ? <ul>{notice.files.map((file, index) => (
          <li key={`${index}-${file.filename}`}>
            <strong>{file.filename}</strong> · {t(file.status === 'queued' ? 'Dodano do kolejki' :
              file.status === 'duplicate' ? 'Już w bibliotece' : errorLabel(file.error || 'Import nie powiódł się'))}
          </li>
        ))}</ul> : null}
      </div>
    </div>
  );
}

export function App() {
  const { language, t } = useLanguage();
  const { path, navigate } = useNavigation();
  const selectedId = path.match(/^\/workouts\/([^/]+)\/?$/)?.[1] ?? null;
  const workoutUrl = selectedId ? `/api/workouts/${selectedId}` : null;
  const title = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const revisionCounter = useRef(0);
  const [pending, setPending] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const lastSyncNotice = useRef<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [action, setAction] = useState<{ path: string; notice: Notice } | null>(null);
  const [knownSports, setKnownSports] = useState<string[]>([]);
  const status = useResource<Status>('/api/status', revision, 3_000);
  const timeZone = status.data?.timeZone ?? undefined;
  const dates = useMemo(() => formatDates(timeZone, language), [timeZone, language]);
  const active = Boolean(status.data && status.data.jobs.queued + status.data.jobs.running);
  const refreshRate = active ? 3_000 : 15_000;
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
  if (filters.sport) query.set('sport', filters.sport);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.from || filters.to) {
    query.set('timeZone', timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  const workouts = useResource<Workouts>(selectedId ? null : `/api/workouts?${query}`, revision, refreshRate);
  const detail = useResource<Detail>(workoutUrl, revision, refreshRate);
  const notice = action?.path === path ? action.notice : null;
  const syncPhase = status.data?.trainingWork?.syncPhase;
  const syncStarting = pending === 'sync' || syncRevision > (status.revision ?? 0);
  const syncBusy = !status.error && (syncStarting || syncPhase === 'listing' || syncPhase === 'analyzing');
  const rateLimited = !status.error && syncPhase === 'rate-limit';
  const syncLabel = status.error ? 'Pobierz nowe treningi'
    : syncStarting ? 'Uruchamianie synchronizacji…'
    : syncPhase === 'listing' ? 'Pobieranie z Suunto…'
    : syncPhase === 'analyzing' ? 'Analizowanie treningów…'
    : rateLimited ? 'Oczekiwanie na limit Suunto'
    : 'Pobierz nowe treningi';

  useEffect(() => {
    if (workouts.data?.sports) setKnownSports(workouts.data.sports);
  }, [workouts.data?.sports]);

  useEffect(() => {
    window.scrollTo(0, 0);
    title.current?.focus({ preventScroll: true });
  }, [path]);

  useEffect(() => {
    const heading = detail.data ? sportLabel(detail.data.sport, language) : t('Lista aktywności');
    document.title = `${heading} · Suunto Cloud`;
  }, [detail.data?.sport, language, t]);

  const refresh = useCallback(() => {
    const next = ++revisionCounter.current;
    setRevision(next);
    return next;
  }, []);

  useEffect(() => {
    const result = status.data?.lastSyncResult;
    if (!result) return;
    const key = `${result.id}:${result.scheduledAt}`;
    const outcome = syncOutcome(result);
    let cancelled = false;
    function notify() {
      if (cancelled || lastSyncNotice.current === key) return;
      lastSyncNotice.current = key;
      try {
        if (localStorage.getItem(syncNoticeStorageKey) === key) return;
        localStorage.setItem(syncNoticeStorageKey, key);
      } catch {
        // The in-memory key still prevents repeated notices while the page is open.
      }
      setSyncNotice(outcome);
      refresh();
    }
    if (navigator.locks) void navigator.locks.request(syncNoticeStorageKey, notify).catch(notify);
    else notify();
    return () => { cancelled = true; };
  }, [status.data?.lastSyncResult, refresh]);

  useEffect(() => {
    if (!syncNotice) return;
    const delay = syncNotice.tone === 'error' || syncNotice.tone === 'warning' ? 8_000 : 5_000;
    const timer = window.setTimeout(
      () => setSyncNotice((current) => current === syncNotice ? null : current), delay,
    );
    return () => window.clearTimeout(timer);
  }, [syncNotice]);

  async function synchronize() {
    setPending('sync');
    setSyncNotice(null);
    try {
      const { queued } = await submit<{ queued: boolean }>('/api/sync');
      setSyncNotice({
        tone: 'info', text: queued ? 'Uruchomiono synchronizację z Suunto.' : 'Synchronizacja z Suunto już trwa.',
      });
      setSyncRevision(refresh());
    } catch (error) {
      setSyncNotice({ tone: 'error', text: messageFromError(error) });
    } finally {
      setPending(null);
    }
  }

  async function mutate(key: string, endpoint: string, success: string) {
    setPending(key);
    setAction(null);
    try {
      await submit(endpoint);
      setAction({ path, notice: { text: success } });
    } catch (error) {
      setAction({ path, notice: { text: messageFromError(error), error: true } });
    } finally {
      setPending(null);
      refresh();
    }
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    setPending('import');
    setAction(null);
    const body = new FormData();
    for (const file of files) body.append('files', file);
    try {
      const result = await submit<ImportResult>('/api/import', body);
      const failed = Boolean(result.error) || result.files.some((file) => file.status === 'failed');
      const imported = result.files.filter((file) => file.status === 'queued').length;
      const text = result.error ? errorLabel(result.error) : imported ? 'Pliki dodane do analizy ({count}).' :
        failed ? 'Wybrane pliki nie zostały dodane.' : 'Wybrane pliki są już w bibliotece.';
      setAction({ path, notice: { text, count: imported, files: result.files, error: failed } });
    } catch (error) {
      setAction({ path, notice: { text: messageFromError(error), error: true } });
    } finally {
      setPending(null);
      refresh();
    }
  }

  function changeFilters(next: Filters) {
    setFilters(next);
    setPage(0);
  }
  const list = workouts.data?.workouts;
  const total = workouts.data?.total;
  const isFiltered = Boolean(filters.sport || filters.from || filters.to);
  const offset = page * pageSize;
  const serverError = status.error || workouts.error || detail.error;
  const displayError = selectedId && !detail.data ? undefined : serverError;

  return (
    <>
      <a href="#main-content" className="skip-link">{t("Przejdź do treści")}</a>
      <Header status={status.data} serviceDown={Boolean(status.error)} navigate={navigate}
        onSettings={() => setSettingsSection('suunto')} />
      {syncNotice && <SyncToast notice={syncNotice} dismiss={() => setSyncNotice(null)} />}
      {settingsSection && <AppSettings initialSection={settingsSection} authorized={status.data?.authorized === true}
        onClose={() => setSettingsSection(null)} onAIChange={refresh} />}
      {showErrors && <JobErrors dates={dates} revision={revision} onClose={() => setShowErrors(false)}
        onChange={refresh} navigate={navigate} />}
      <main className="page" id="main-content">
        {selectedId ? (
          <>
            <a href="/" onClick={navigate} className="button button--primary back-link">
              <ArrowLeft size={19} aria-hidden="true" /> {t('Wróć do listy treningów')}
            </a>
            <div className="page-header">
              <div>
                <h1 ref={title} tabIndex={-1}>{detail.data ? sportLabel(detail.data.sport, language) : t('Szczegóły treningu')}</h1>
                {detail.data && <div className="detail-meta">
                  <time dateTime={new Date(detail.data.startedAt).toISOString()}>{dates.dateLong(detail.data.startedAt)}, {dates.timeLabel(detail.data.startedAt)}</time>
                  {!detail.data.chart && detail.data.deviceModel && <span className="detail-device">
                    <Watch size={16} aria-hidden="true" /> {detail.data.deviceModel}
                  </span>}
                  <SourceLabel source={detail.data.source} />
                  <WorkoutStatus status={detail.data.status} />
                </div>}
              </div>
            </div>
            <Feedback notice={notice} />
            {displayError && <Feedback notice={{ text: displayError, error: true }} />}
            {detail.loading && <StatePanel icon={<Clock3 size={23} aria-hidden="true" />} title={t("Wczytywanie treningu…")} />}
            {!detail.data && detail.error && <StatePanel icon={<CircleAlert size={23} aria-hidden="true" />} title={detail.error}>
              <button type="button" className="button" onClick={refresh}>{t("Odśwież")}</button>
            </StatePanel>}
            {detail.data && <WorkoutDetail
              workout={detail.data}
              dates={dates}
              interpretationAvailability={status.data?.interpretationAvailability}
              openProviderSettings={setSettingsSection}
              pending={pending}
              retry={() => void mutate('retry', `${workoutUrl}/retry`, 'Dodano trening do ponownej analizy.')}
              interpret={(provider) => void mutate(`interpret-${provider}`, `${workoutUrl}/interpret?lang=${language}&provider=${provider}`, 'Dodano interpretację do kolejki.')}
            />}
          </>
        ) : (
          <>
            <div className="page-header">
              <h1 ref={title} tabIndex={-1}>{t('Lista aktywności')}</h1>
              <div className="page-actions">
                <input ref={fileInput} type="file" multiple accept=".fit" hidden onChange={(event) => void importFiles(event)} />
                <button className="button" type="button" disabled={Boolean(pending) || Boolean(status.error)}
                  onClick={() => fileInput.current?.click()}>
                  {pending === 'import' ? <LoaderCircle className="spinning" size={18} aria-hidden="true" />
                    : <Upload size={18} aria-hidden="true" />}
                  {t(pending === 'import' ? 'Wysyłanie plików…' : 'Importuj FIT')}
                </button>
                <button className={`button button--primary${syncBusy ? ' button--working' : ''}`} type="button"
                  disabled={Boolean(pending) || Boolean(status.error) || syncBusy || rateLimited}
                  aria-busy={syncBusy}
                  onClick={() => void synchronize()}>
                  {syncBusy ? <LoaderCircle className="spinning" size={18} aria-hidden="true" />
                    : <RefreshCw size={18} aria-hidden="true" />}
                  {t(syncLabel)}
                </button>
              </div>
            </div>
            <StatStrip total={total} status={status.data} dates={dates} filtered={isFiltered} onErrors={() => setShowErrors(true)} />
            <div className="training-status" role="status" aria-live="polite">
              {syncBusy && <span>{t(syncLabel)} {t('Treningi pojawią się na liście w miarę zapisywania.')}</span>}
              {rateLimited && status.data?.trainingWork?.retryAt &&
                <span>{t('Synchronizacja wznowi się po {date}.', { date: dates.dateTime(status.data.trainingWork.retryAt) })}</span>}
              {!status.error && Boolean(status.data?.trainingWork?.localPending) && <span>
                <LoaderCircle className="spinning" size={16} aria-hidden="true" /> {t('Analizowanie zaimportowanych plików FIT…')}
              </span>}
            </div>
            <Feedback notice={notice} />
            {displayError && <Feedback notice={{ text: displayError, error: true }} />}
            {status.data?.authorized === false && <Feedback notice={{
              text: 'Zapisz dane API w ustawieniach Suunto i dokończ logowanie OAuth. Pierwszy import rozpocznie się automatycznie.',
            }} />}
            <section className="panel library" aria-labelledby="library-heading">
              <div className="panel__header">
                <h2 id="library-heading">{t("Aktywności")}</h2>
                <FilterBar filters={filters} setFilters={changeFilters} sports={workouts.data?.sports ?? knownSports} />
              </div>
              {list?.length ? <WorkoutTable workouts={list} navigate={navigate} dates={dates} /> : (
                workouts.loading ? <StatePanel icon={<Clock3 size={23} aria-hidden="true" />} title={t("Wczytywanie biblioteki…")} /> :
                workouts.error ? <StatePanel icon={<CircleAlert size={23} aria-hidden="true" />} title={t("Biblioteka jest niedostępna")}>
                  <button className="button" type="button" onClick={refresh}>{t("Odśwież")}</button>
                </StatePanel> :
                isFiltered ? <StatePanel icon={<ListFilter size={23} aria-hidden="true" />} title={t("Brak treningów dla tych filtrów")}>
                  <button className="button" type="button" onClick={() => changeFilters(noFilters)}>{t("Wyczyść filtry")}</button>
                </StatePanel> :
                <StatePanel icon={<Route size={24} aria-hidden="true" />} title={active ? 'Import w toku' : 'Biblioteka jest pusta'}>
                  <p>{t(active ? 'Treningi pojawią się po pobraniu metadanych.' : 'Pobierz treningi z Suunto albo wybierz pliki FIT z dysku.')}</p>
                </StatePanel>
              )}
              {typeof total === 'number' && (total > pageSize || page > 0) && <nav className="pagination" aria-label={t("Strony treningów")}>
                <span>{list?.length ? t('{start}–{end} z {total}', { start: offset + 1, end: offset + list.length, total })
                  : t('Liczba wyników: {total}', { total })}</span>
                <div>
                  <button className="button" type="button" aria-label={t("Poprzednia strona")} disabled={!page}
                    onClick={() => setPage(page - 1)}>{t("Poprzednia")}</button>
                  <button className="button" type="button" aria-label={t("Następna strona")} disabled={offset + pageSize >= total}
                    onClick={() => setPage(page + 1)}>{t("Następna")}</button>
                </div>
              </nav>}
            </section>
          </>
        )}
      </main>
    </>
  );
}
