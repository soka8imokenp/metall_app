import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ru, Dict } from './ru';
import { uz } from './uz';
import { storage } from '@/lib/storage';

export type Locale = 'ru' | 'uz';
const dicts: Record<Locale, Dict> = { ru, uz };

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: keyof Dict) => string;
  /** Выбрать из объекта API поле на текущем языке: `pick(item, 'name')` → nameUz или nameRu. */
  pick: (obj: any, base: string) => string;
};

const I18nCtx = createContext<Ctx>({
  locale: 'ru',
  setLocale: () => {},
  t: (k) => ru[k],
  pick: () => '',
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ru');

  useEffect(() => {
    storage.get('locale').then((v) => {
      if (v === 'ru' || v === 'uz') setLocaleState(v);
    });
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    storage.set('locale', l);
  }, []);

  const value = useMemo<Ctx>(() => {
    const d = dicts[locale];
    return {
      locale,
      setLocale,
      t: (k) => d[k] ?? ru[k] ?? String(k),
      pick: (obj, base) => {
        if (!obj) return '';
        const ru = obj[`${base}Ru`];
        const uz = obj[`${base}Uz`];
        // в API русское значение часто лежит в поле без суффикса (`partnerName` + `partnerNameUz`)
        return locale === 'uz' ? uz || ru || obj[base] || '' : ru || obj[base] || uz || '';
      },
    };
  }, [locale, setLocale]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
