import React, { useState } from 'react';
import type { FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { messageFromError, remove, submitJson, useResource } from './api';
import { useLanguage } from './i18n';
import { providerNames } from '../../shared/providers';
import type { Provider } from '../../shared/providers';

type Settings = { configured: boolean; editable: boolean };
const keyUrls: Record<Provider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  claude: 'https://platform.claude.com/settings/keys',
};

export function AISettings({ provider, onChange }: { provider: Provider; onChange: () => void }) {
  const { t } = useLanguage();
  const name = providerNames[provider];
  const settingsUrl = `/api/${provider}/settings`;
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState<Settings>();
  const [pending, setPending] = useState<'save' | 'remove' | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const settings = useResource<Settings>(settingsUrl, revision, 0);
  const data = saved ?? settings.data;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setPending('save');
    setNotice(undefined);
    try {
      const result = await submitJson<Settings>(settingsUrl, { apiKey: String(fields.get('apiKey') ?? '') });
      form.reset();
      setSaved(result);
      setNotice({ text: 'Zapisano klucz API {provider}.' });
      onChange();
    } catch (error) {
      setNotice({ text: messageFromError(error), error: true });
    } finally {
      setPending(null);
    }
  }

  async function deleteKey() {
    setPending('remove');
    setNotice(undefined);
    try {
      setSaved(await remove<Settings>(settingsUrl));
      setConfirmRemoval(false);
      setNotice({ text: 'Usunięto klucz API {provider} z aplikacji.' });
      onChange();
    } catch (error) {
      setNotice({ text: messageFromError(error), error: true });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="panel__body">
      {settings.loading && <p role="status" className="settings-progress">
        <LoaderCircle className="spinning" size={18} aria-hidden="true" /> {t('Wczytywanie ustawień…')}
      </p>}
      {settings.error && <div className="settings-message" role="alert">
        <p>{t(settings.error)}</p>
        <button className="button" type="button" onClick={() => setRevision((value) => value + 1)}>{t('Ponów')}</button>
      </div>}
      {data?.editable && <form className="settings-form" onSubmit={(event) => void save(event)} autoComplete="off">
        <label>
          <span>{t('Klucz API {provider}', { provider: name })}</span>
          <input name="apiKey" type="password" autoComplete="new-password" maxLength={1024}
            placeholder={data.configured ? t('Zapisany · wpisz, aby zmienić') : undefined} required />
        </label>
        {provider === 'claude' && <p className="muted">
          {t('Tworząc klucz Claude, przypisz go do jednego obszaru roboczego.')}
        </p>}
        <div className="settings-footer">
          <a href={keyUrls[provider]} target="_blank" rel="noreferrer">
            {t('Utwórz klucz w {provider}', { provider: name })}
          </a>
          <button type="submit" className="button button--primary" disabled={Boolean(pending) || confirmRemoval}>
            {pending === 'save' && <LoaderCircle className="spinning" size={17} aria-hidden="true" />}
            {t(pending === 'save' ? 'Zapisywanie…' : 'Zapisz')}
          </button>
        </div>
        {data.configured && (confirmRemoval ? <div className="settings-removal" role="group" aria-label={t('Usuwanie klucza API')}>
          <p>{t('Usunąć zapisany klucz API {provider} z aplikacji?', { provider: name })}</p>
          <div className="settings-removal__actions">
            <button type="button" className="button" disabled={Boolean(pending)} onClick={() => setConfirmRemoval(false)}>{t('Anuluj')}</button>
            <button type="button" className="button button--primary" disabled={Boolean(pending)} onClick={() => void deleteKey()}>
              {pending === 'remove' && <LoaderCircle className="spinning" size={17} aria-hidden="true" />}
              {t('Usuń klucz')}
            </button>
          </div>
        </div> : <button type="button" className="button button--quiet settings-remove" disabled={Boolean(pending)}
          onClick={() => setConfirmRemoval(true)}>{t('Usuń zapisany klucz')}</button>)}
        {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'text-error' : undefined}>
          {t(notice.text, { provider: name })}
        </p>}
      </form>}
      {data && !data.editable && <p className="muted">
        {t(data.configured ? 'Klucz API {provider} jest ustawiony w konfiguracji workera.'
          : 'Klucz API {provider} ustawia się w konfiguracji workera.', { provider: name })}
      </p>}
    </div>
  );
}
