import { useLanguage } from './i18n';
import React, { useState } from 'react';
import type { FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { messageFromError, submitJson, useResource } from './api';

type Settings = {
  clientId: string | null;
  redirectUri: string;
  clientSecretSaved: boolean;
  subscriptionKeySaved: boolean;
};

const settingsUrl = '/api/suunto/settings';

export function SuuntoSettings({ authorized }: { authorized: boolean }) {
  const { t } = useLanguage();
  const [revision, setRevision] = useState(0);
  const [savedSettings, setSavedSettings] = useState<Settings>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const settings = useResource<Settings>(settingsUrl, revision, 0);
  const data = savedSettings ?? settings.data;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setSaving(true);
    setNotice(undefined);
    try {
      const result = await submitJson<Settings>(settingsUrl, {
        clientId: String(fields.get('clientId') ?? ''),
        clientSecret: String(fields.get('clientSecret') ?? ''),
        subscriptionKey: String(fields.get('subscriptionKey') ?? ''),
      });
      form.reset();
      setSavedSettings(result);
      setNotice({ text: 'Zapisano ustawienia Suunto.' });
    } catch (error) {
      setNotice({ text: messageFromError(error), error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
      <div className="panel__body">
        {settings.loading && <p role="status" className="settings-progress"><LoaderCircle className="spinning" size={18}
          aria-hidden="true" />{t("Wczytywanie ustawień…")}</p>}
        {settings.error && <div className="settings-message" role="alert">
          <p>{t(settings.error)}</p>
          <button className="button" type="button" onClick={() => setRevision((value) => value + 1)}>{t("Ponów")}</button>
        </div>}
        {data && <form key={data.clientId ?? ''} className="settings-form" onSubmit={(event) => void save(event)} autoComplete="off">
          <label>
            <span>Client ID</span>
            <input name="clientId" defaultValue={data.clientId ?? ''} readOnly={Boolean(data.clientId)} maxLength={512}
              spellCheck={false} required />
          </label>
          <label>
            <span>Client secret</span>
            <input name="clientSecret" type="password" autoComplete="new-password" maxLength={512}
              placeholder={data.clientSecretSaved ? t('Zapisany · wpisz, aby zmienić') : undefined}
              required={!data.clientSecretSaved} />
          </label>
          <label>
            <span>{t("Klucz subskrypcji Developer API")}</span>
            <input name="subscriptionKey" type="password" autoComplete="new-password" maxLength={512}
              placeholder={data.subscriptionKeySaved ? t('Zapisany · wpisz, aby zmienić') : undefined}
              required={!data.subscriptionKeySaved} />
          </label>
          <div className="settings-footer">
            <a href="https://apizone.suunto.com/profile" target="_blank" rel="noreferrer">Suunto API Zone</a>
            <button type="submit" className="button button--primary" disabled={saving}>
              {saving && <LoaderCircle className="spinning" size={17} aria-hidden="true" />}
              {t(saving ? 'Zapisywanie…' : 'Zapisz')}
            </button>
          </div>
          {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'text-error' : undefined}>
            {t(notice.text)}
          </p>}
          {!authorized && data.clientSecretSaved && data.subscriptionKeySaved && (
            <p className="muted">{t('Aby zalogować się na konto Suunto, uruchom polecenie OAuth w terminalu.')}
              {' '}{t('Adres przekierowania w API Zone to')} <code>{data.redirectUri}</code>.</p>
          )}
        </form>}
      </div>
  );
}
