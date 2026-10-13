/**
 * Flattened message catalog (`<namespace>.<key>`) for every locale.
 * Each namespace file is owned by one layer; see the header of each file.
 */
import type { Locale } from '../contracts/app-settings.ts';
import type { NamespaceMessages } from './define.ts';
import { createTranslator, type FlatCatalog, type Translator } from './translator.ts';
import { conversationEventsMessages } from './messages/conversationEvents.ts';
import { errorMessages } from './messages/errors.ts';
import { logsMessages } from './messages/logs.ts';
import { mainMessages } from './messages/main.ts';
import { noticesMessages } from './messages/notices.ts';
import { noticesDownloadsMessages } from './messages/notices-downloads.ts';
import { noticesRuntimeMessages } from './messages/notices-runtime.ts';
import { outcomesMessages } from './messages/outcomes.ts';
import { runtimeProgressMessages } from './messages/runtimeProgress.ts';
import { uiMessages } from './messages/ui.ts';

/**
 * Namespace → message files. A namespace may be split across several files so
 * that each file has a single owner (keys must not collide; enforced by tests).
 */
const NAMESPACES = {
  errors: [errorMessages],
  notices: [noticesMessages, noticesDownloadsMessages, noticesRuntimeMessages],
  conversationEvents: [conversationEventsMessages],
  runtimeProgress: [runtimeProgressMessages],
  logs: [logsMessages],
  outcomes: [outcomesMessages],
  main: [mainMessages],
  ui: [uiMessages]
} as const;

type Namespaces = typeof NAMESPACES;

type KeysOf<N extends NamespaceMessages<string>> = N extends NamespaceMessages<infer K> ? K : never;

type StripPlural<K extends string> = K extends `${infer Base}_one` ? Base : K extends `${infer Base}_other` ? Base : K;

export type MessageKey = {
  [N in keyof Namespaces]: `${N}.${StripPlural<KeysOf<Namespaces[N][number]> & string>}`;
}[keyof Namespaces];

function flatten(locale: Locale): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [namespace, files] of Object.entries(NAMESPACES)) {
    for (const messages of files as readonly NamespaceMessages<string>[]) {
      for (const [key, value] of Object.entries(messages[locale])) {
        const fullKey = `${namespace}.${key}`;
        if (fullKey in out) throw new Error(`Duplicate i18n key: ${fullKey}`);
        out[fullKey] = value;
      }
    }
  }
  return out;
}

export const CATALOG: FlatCatalog = { pt: flatten('pt'), en: flatten('en'), es: flatten('es') };

export function translatorFor(locale: Locale): Translator<MessageKey> {
  return createTranslator<MessageKey>(locale, CATALOG);
}

export const LOCALE_LABELS: Readonly<Record<Locale, string>> = { pt: 'Português', en: 'English', es: 'Español' };

/** Best-effort locale detection from a BCP-47 tag (e.g. `navigator.language`, `app.getLocale()`). */
export function detectLocale(tag: string | undefined): Locale {
  const lang = (tag ?? '').toLowerCase();
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('es')) return 'es';
  return 'pt';
}
