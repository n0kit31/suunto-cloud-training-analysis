import React, { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { providerNames } from '../../shared/providers';
import { errorLabel, messageFromError, remove, useResource } from './api';
import type { JobFailure } from './api';
import { sportLabel } from './format';
import type { DateLabels } from './format';
import { useLanguage } from './i18n';

export function JobErrors({ dates, revision, onClose, onChange, navigate }: {
  dates: DateLabels; revision: number; onClose: () => void; onChange: () => void;
  navigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { language, t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [removing, setRemoving] = useState<number | 'all' | null>(null);
  const [notice, setNotice] = useState<string>();
  const path = '/api/jobs/errors';
  const failures = useResource<{ errors: JobFailure[] }>(path, revision, 3_000);
  const errors = failures.data?.errors ?? [];
  const errorMessage = notice ?? failures.error;

  useEffect(() => {
    const panel = dialog.current;
    if (panel && !panel.open) panel.showModal();
  }, []);

  async function dismiss(id: number | 'all') {
    setRemoving(id);
    setNotice(undefined);
    try {
      await remove(id === 'all' ? path : `${path}/${id}`);
      onChange();
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <dialog ref={dialog} className="settings-dialog job-errors" aria-labelledby="job-errors-title" onClose={onClose}>
      <div className="panel__header">
        <h2 id="job-errors-title">{t('Błędy zadań')}</h2>
        <button type="button" className="button button--quiet settings-close" aria-label={t('Zamknij')}
          onClick={() => dialog.current?.close()}><X size={19} aria-hidden="true" /></button>
      </div>
      <div className="panel__body job-errors__body">
        {failures.loading && <p className="settings-progress" role="status">
          <LoaderCircle size={17} className="spinning" aria-hidden="true" /> {t('Wczytywanie błędów…')}
        </p>}
        {errorMessage && <p className="text-error" role="alert">{t(errorMessage)}</p>}
        {failures.data && errors.length === 0 && <p className="muted" role="status">{t('Brak błędów zadań.')}</p>}
        {errors.length > 0 && <>
          <ul className="job-errors__list">
            {errors.map((job) => (
              <li key={job.id}>
                <div className="job-errors__name">
                  <h3>{job.kind === 'sync' ? t('Synchronizacja Suunto') : job.kind === 'analyze' ? t('Analiza treningu')
                    : `${t('Interpretacja')} · ${providerNames[job.provider]}`}</h3>
                  <time dateTime={new Date(job.scheduledAt).toISOString()}>{dates.dateTime(job.scheduledAt)}</time>
                </div>
                <p>{t(errorLabel(job.error || 'Wystąpił błąd. Spróbuj ponownie.'))}</p>
                <div className="job-errors__actions">
                  {job.workoutId && <a href={`/workouts/${encodeURIComponent(job.workoutId)}`} onClick={(event) => {
                    navigate(event);
                    if (event.defaultPrevented) dialog.current?.close();
                  }}>{job.sport ? sportLabel(job.sport, language) : t('Szczegóły treningu')}</a>}
                  <button type="button" className="button button--quiet" onClick={() => void dismiss(job.id)}
                    disabled={removing !== null}>{t('Usuń błąd')}</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="job-errors__footer">
            <button type="button" className="button" disabled={removing !== null} onClick={() => void dismiss('all')}>
              {t('Wyczyść listę błędów')}
            </button>
          </div>
        </>}
      </div>
    </dialog>
  );
}
