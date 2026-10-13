/**
 * Turns structured data (`code + params`) coming from main/host into localized
 * text. Other layers own the `errors`, `notices`, `conversationEvents`,
 * `outcomes`, `runtimeProgress` and `logs` namespaces, so every lookup here is
 * defensive: missing keys fall back to generic `ui.*` texts, never to raw codes
 * unless nothing better exists.
 */
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import type { TranslateParams, Translator } from '../../../shared/i18n/translator.ts';
import type {
  ConversationEventDto,
  DownloadOutcomeDto,
  LogEntryDto,
  NoticeDto,
  Params,
  RuntimeProgressDto
} from '../../../shared/contracts/dto.ts';

export type UiTranslator = Translator<MessageKey>;

const PLACEHOLDER = /\{\w+\}/g;

/** Removes placeholders left unfilled (missing optional params such as `{detail}`) and tidies spacing. */
export function cleanText(text: string): string {
  return text
    .replace(PLACEHOLDER, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function toParams(params: Params | TranslateParams | undefined): TranslateParams | undefined {
  return params;
}

/** First key that exists wins; `fallback` otherwise. */
export function firstTranslation(
  t: UiTranslator,
  keys: readonly string[],
  params: TranslateParams | undefined,
  fallback: string
): string {
  for (const key of keys) {
    if (t.has(key) || t.has(`${key}_one`)) return cleanText(t.tDynamic(key, params, fallback));
  }
  return fallback;
}

/** `errors.<CODE>` with params; unknown codes fall back to a generic message. */
export function formatError(t: UiTranslator, error: AppErrorData | null | undefined): string {
  if (!error) return t.t('ui.errors.unknown');
  // A `reason` param may select a more specific message: `errors.<CODE>_<reason>`.
  const reason = error.params?.['reason'];
  const keys =
    typeof reason === 'string' ? [`errors.${error.code}_${reason}`, `errors.${error.code}`] : [`errors.${error.code}`];
  return firstTranslation(t, keys, toParams(error.params), t.t('ui.errors.unknown'));
}

export interface NoticeText {
  readonly title: string;
  readonly message: string;
}

const NOTICE_KIND_TITLE: Readonly<Record<NoticeDto['kind'], MessageKey>> = {
  error: 'ui.notices.kind.error',
  warn: 'ui.notices.kind.warn',
  success: 'ui.notices.kind.success',
  info: 'ui.notices.kind.info'
};

export function formatNotice(t: UiTranslator, notice: Pick<NoticeDto, 'code' | 'params' | 'kind'>): NoticeText {
  const params = toParams(notice.params);
  const title = firstTranslation(t, [`notices.${notice.code}.title`], params, t.t(NOTICE_KIND_TITLE[notice.kind]));
  const message = firstTranslation(t, [`notices.${notice.code}.message`, `notices.${notice.code}`], params, '');
  return { title, message };
}

export function formatConversationEvent(
  t: UiTranslator,
  event: Pick<ConversationEventDto, 'code' | 'params' | 'legacyMessage' | 'type'>
): string {
  const fallback =
    event.legacyMessage ?? firstTranslation(t, [`ui.conversation.event.${event.type}`], undefined, event.code);
  const reason = event.params?.['reason'];
  // Prefer the structured outcome reason (e.g. pixiv-auth) over the generic "failed" line.
  if (typeof reason === 'string' && reason && (event.code === 'failed' || event.type === 'failed')) {
    const fromReason = firstTranslation(t, [`outcomes.reason.${reason}`], toParams(event.params), '');
    if (fromReason) return fromReason;
  }
  return firstTranslation(t, [`conversationEvents.${event.code}`], toParams(event.params), fallback);
}

/** Human summary of a finished download outcome. */
export function formatOutcome(t: UiTranslator, outcome: DownloadOutcomeDto, params?: TranslateParams): string {
  const keys: string[] = [];
  // Host catalog scheme (src/shared/i18n/messages/outcomes.ts): `outcomes.reason.<reason>`.
  if (outcome.reason) keys.push(`outcomes.reason.${outcome.reason}`);
  keys.push(`outcomes.${outcome.kind}`, `ui.outcome.${outcome.kind}`);
  return firstTranslation(t, keys, { detail: outcome.detail ?? '', ...params }, t.t('ui.outcome.unknown'));
}

export function formatRuntimeProgress(t: UiTranslator, progress: Pick<RuntimeProgressDto, 'code' | 'params'>): string {
  return firstTranslation(
    t,
    [`runtimeProgress.${progress.code}`],
    toParams(progress.params),
    t.t('ui.runtime.progress.working')
  );
}

export function formatLogEntry(t: UiTranslator, entry: Pick<LogEntryDto, 'text' | 'code' | 'params'>): string {
  if (entry.text !== null) return entry.text;
  if (!entry.code) return '';
  return firstTranslation(t, [`logs.${entry.code}`], toParams(entry.params), entry.code);
}
