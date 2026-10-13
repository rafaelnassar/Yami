/**
 * React binding for the shared catalog. The app root passes the current
 * `settings.locale`; components read translators/formatters through hooks.
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Locale } from '../../../shared/contracts/app-settings.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import { createFormatters, localeTag, type Formatters } from './format.ts';
import type { UiTranslator } from './text.ts';
import { withZeroForms } from './zero-forms.ts';

interface I18nValue {
  readonly locale: Locale;
  readonly t: UiTranslator;
  readonly format: Formatters;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18nValue>(
    () => ({ locale, t: withZeroForms(translatorFor(locale)), format: createFormatters(locale) }),
    [locale]
  );

  useEffect(() => {
    document.documentElement.lang = localeTag(locale);
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider is missing');
  return value;
}

/** Translator bound to the current UI locale (`t`, `tDynamic`, `has`). */
export function useT(): UiTranslator {
  return useI18n().t;
}

/** Locale-aware formatters (bytes, dates, relative time…). */
export function useFormat(): Formatters {
  return useI18n().format;
}

export function useLocale(): Locale {
  return useI18n().locale;
}
