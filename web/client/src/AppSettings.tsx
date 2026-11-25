import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from './i18n';
import { AISettings } from './AISettings';
import { SuuntoSettings } from './SuuntoSettings';
import { providers, providerNames } from '../../shared/providers';
import type { Provider } from '../../shared/providers';

export type SettingsSection = 'suunto' | Provider;

export function AppSettings({ initialSection, authorized, onClose, onAIChange }: {
  initialSection: SettingsSection; authorized: boolean; onClose: () => void; onAIChange: () => void;
}) {
  const { t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState(initialSection);
  useEffect(() => {
    const panel = dialog.current;
    if (panel && !panel.open) panel.showModal();
  }, []);

  return (
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="app-settings-title" onClose={onClose}>
      <div className="panel__header">
        <h2 id="app-settings-title">{t('Ustawienia aplikacji')}</h2>
        <button type="button" className="button button--quiet settings-close" aria-label={t('Zamknij ustawienia')}
          onClick={() => dialog.current?.close()}>
          <X size={19} aria-hidden="true" />
        </button>
      </div>
      <div className="settings-sections" role="group" aria-label={t('Sekcje ustawień')}>
        <button type="button" className="button" aria-pressed={section === 'suunto'}
          onClick={() => setSection('suunto')}>Suunto</button>
        {providers.map((provider) => <button key={provider} type="button" className="button"
          aria-pressed={section === provider} onClick={() => setSection(provider)}>{providerNames[provider]}</button>)}
      </div>
      {section === 'suunto'
        ? <SuuntoSettings authorized={authorized} />
        : <AISettings key={section} provider={section} onChange={onAIChange} />}
    </dialog>
  );
}
