import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useLanguage } from './i18n';

const languages = [
  { code: 'en', flag: 'gb', name: 'English' },
  { code: 'pl', flag: 'pl', name: 'Polski' },
] as const;

export function LanguageMenu() {
  const { language, setLanguage, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = languages.find(({ code }) => code === language)!;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div className="language-menu" ref={menu} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }}>
      <button type="button" className="language-menu__trigger" ref={trigger} aria-expanded={open}
        aria-controls="interface-languages" aria-label={`${t('Język interfejsu')}, ${current.name}`}
        onClick={() => setOpen(!open)}>
        <span className={`language-flag language-flag--${current.flag}`} aria-hidden="true" />
        <span>{language.toUpperCase()}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <ul className="language-menu__options" id="interface-languages" hidden={!open}>
        {languages.map(({ code, flag, name }) => (
          <li key={code}>
            <button type="button" lang={code} aria-current={language === code ? 'true' : undefined}
              onClick={() => { setLanguage(code); close(); }}>
              <span className={`language-flag language-flag--${flag}`} aria-hidden="true" />
              <span>{name}</span>
              {language === code && <Check size={15} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
