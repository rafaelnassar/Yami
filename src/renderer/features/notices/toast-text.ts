/** Translates toast specs (keys, errors, outcomes, host notices) into display text. */
import type { ToolStatusDto } from '../../../shared/contracts/dto.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import { cleanText, formatError, formatNotice, formatOutcome, type UiTranslator } from '../../shared/i18n/text.ts';
import type { Toast, ToastText } from './notices-store.ts';

export function formatToastText(t: UiTranslator, text: ToastText | null): string {
  if (!text) return '';
  switch (text.kind) {
    case 'key':
      return cleanText(t.t(text.key, text.params));
    case 'error':
      return formatError(t, text.error);
    case 'outcome':
      return formatOutcome(t, text.outcome);
    case 'raw':
      return text.text;
  }
}

export const TOOL_LABELS: Readonly<Record<ToolId, string>> = {
  'gallery-dl': 'gallery-dl',
  'yt-dlp': 'yt-dlp',
  deno: 'Deno',
  ffmpeg: 'ffmpeg',
  python: 'Python'
};

/** Title/message of a toast; runtime-update notices get a version summary from the current tool list. */
export function toastContent(
  t: UiTranslator,
  toast: Toast,
  tools: readonly Pick<ToolStatusDto, 'id' | 'version' | 'latestVersion'>[]
): { readonly title: string; readonly message: string } {
  if (toast.action?.type === 'runtime-update') {
    const ids = toast.action.tools;
    const title = t.t('ui.toast.runtimeUpdate.title');
    if (ids.length === 1 && ids[0]) {
      const tool = tools.find((item) => item.id === ids[0]);
      return {
        title,
        message: t.t('ui.toast.runtimeUpdate.one', {
          name: TOOL_LABELS[ids[0]],
          current: tool?.version ?? '—',
          latest: tool?.latestVersion ?? '—'
        })
      };
    }
    return {
      title,
      message: t.t('ui.toast.runtimeUpdate.many', {
        count: ids.length,
        names: ids.map((id) => TOOL_LABELS[id]).join(', ')
      })
    };
  }
  if (toast.notice) return formatNotice(t, toast.notice);
  return { title: formatToastText(t, toast.title), message: formatToastText(t, toast.message) };
}
