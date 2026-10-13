import type { Locale } from '../contracts/app-settings.ts';
import type { ParamValue } from '../contracts/dto.ts';

export type TranslateParams = Readonly<Record<string, ParamValue | undefined>>;

export type FlatCatalog = Readonly<Record<Locale, Readonly<Record<string, string>>>>;

export interface Translator<K extends string = string> {
  readonly locale: Locale;
  /** Translates a known key. Falls back to Portuguese, then to the key itself. */
  t(key: K, params?: TranslateParams): string;
  /** Translates a dynamic key (e.g. built from an error code); returns `fallback` when missing. */
  tDynamic(key: string, params?: TranslateParams, fallback?: string): string;
  has(key: string): boolean;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

export function createTranslator<K extends string>(locale: Locale, catalog: FlatCatalog): Translator<K> {
  const primary = catalog[locale];
  const fallback = catalog.pt;
  const plurals = new Intl.PluralRules(locale);

  const lookup = (key: string, params?: TranslateParams): string | undefined => {
    const count = params?.['count'];
    if (typeof count === 'number') {
      const category = plurals.select(count);
      const pluralKey = `${key}_${category === 'one' ? 'one' : 'other'}`;
      const plural = primary[pluralKey] ?? fallback[pluralKey];
      if (plural !== undefined) return plural;
    }
    return primary[key] ?? fallback[key];
  };

  return {
    locale,
    t: (key, params) => interpolate(lookup(key, params) ?? key, params),
    tDynamic: (key, params, fallbackText) => {
      const template = lookup(key, params);
      return template === undefined ? (fallbackText ?? key) : interpolate(template, params);
    },
    has: (key) => lookup(key) !== undefined
  };
}
