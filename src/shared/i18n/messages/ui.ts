/**
 * `ui.*` — renderer texts (owner: renderer). Split by area in `./ui/*.ts` and
 * merged here; the catalog only imports `uiMessages`. The home greetings are
 * exported separately (`UI_GREETINGS`) because they are lists, not keys.
 */
import type { NamespaceMessages } from '../define.ts';
import { uiAppMessages } from './ui/app.ts';
import { uiDownloadsMessages } from './ui/downloads.ts';
import { uiFeedbackMessages } from './ui/feedback.ts';
import { uiLogsMessages } from './ui/logs.ts';
import { uiPreviewMessages } from './ui/preview.ts';
import { uiRuntimeMessages } from './ui/runtime.ts';
import { uiSessionMessages } from './ui/session.ts';
import { uiSettingsMessages } from './ui/settings.ts';
import { uiSidebarMessages } from './ui/sidebar.ts';
import { uiTrayMessages } from './ui/tray.ts';
import { uiVaultMessages } from './ui/vault.ts';

export { UI_GREETINGS } from './ui/greetings.ts';

type KeysOf<N> = N extends NamespaceMessages<infer K> ? K : never;

/** Merges message tables of one namespace; duplicate keys are a programming error. */
function mergeMessages<const T extends readonly NamespaceMessages<string>[]>(
  ...parts: T
): NamespaceMessages<KeysOf<T[number]>> {
  const merged = {
    pt: {} as Record<string, string>,
    en: {} as Record<string, string>,
    es: {} as Record<string, string>
  };
  for (const part of parts) {
    for (const locale of ['pt', 'en', 'es'] as const) {
      for (const [key, value] of Object.entries(part[locale])) {
        if (key in merged[locale]) throw new Error(`Duplicate ui message key: ${key}`);
        merged[locale][key] = value;
      }
    }
  }
  return merged as NamespaceMessages<KeysOf<T[number]>>;
}

export const uiMessages = mergeMessages(
  uiAppMessages,
  uiFeedbackMessages,
  uiDownloadsMessages,
  uiSessionMessages,
  uiSidebarMessages,
  uiPreviewMessages,
  uiSettingsMessages,
  uiRuntimeMessages,
  uiLogsMessages,
  uiTrayMessages,
  uiVaultMessages
);
