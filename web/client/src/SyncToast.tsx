import { useLanguage } from './i18n';
import React from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { errorLabel } from './api';
import type { SyncResult } from './api';

export type SyncNotice = {
  tone: 'info' | 'success' | 'warning' | 'error';
  text: string;
  count?: number;
  reason?: string;
  changes?: { added: number; updated: number };
};

export function syncOutcome(result: SyncResult): SyncNotice {
  const changes = result.added + result.updated ? { added: result.added, updated: result.updated } : undefined;
  if (result.status === 'failed') {
    const reason = result.error && result.error !== 'The workout could not be analyzed.'
      ? errorLabel(result.error) : undefined;
    return { tone: 'error', text: 'Synchronizacja z Suunto nie powiodła się.', reason };
  }
  if (result.failed) {
    return { tone: 'warning', text: 'Nie udało się przeanalizować wszystkich treningów. Liczba błędów ({count}).',
      count: result.failed, changes };
  }
  return {
    tone: 'success',
    changes,
    text: changes
      ? 'Synchronizacja zakończona.'
      : 'Synchronizacja zakończona. Brak nowych lub zmienionych treningów.',
  };
}

const icons = { info: Info, success: CircleCheck, warning: CircleAlert, error: CircleAlert };

export function SyncMessage({ notice }: { notice: SyncNotice }) {
  const { t } = useLanguage();
  return <>{t(notice.text, notice.count === undefined ? undefined : { count: notice.count })}
    {notice.reason && <> {t(notice.reason)}</>}
    {notice.changes && <> {t('Dodano {added}, zaktualizowano {updated}.', notice.changes)}</>}</>;
}

export function SyncToast({ notice, dismiss }: { notice: SyncNotice; dismiss: () => void }) {
  const { t } = useLanguage();
  const Icon = icons[notice.tone];
  return (
    <div className={`sync-toast sync-toast--${notice.tone}`}>
      <div className="sync-toast__message" role={notice.tone === 'error' ? 'alert' : 'status'}>
        <Icon size={20} aria-hidden="true" />
        <p><SyncMessage notice={notice} /></p>
      </div>
      <button type="button" className="sync-toast__close" aria-label={t("Zamknij powiadomienie")} onClick={dismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
