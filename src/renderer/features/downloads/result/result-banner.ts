/**
 * Which status banner (if any) the result card should show.
 * Prefer the current download outcome over historic timeline noise.
 */
import type {
  ConversationDetailDto,
  ConversationEventDto,
  DownloadOutcomeDto
} from '../../../../shared/contracts/dto.ts';

export type ResultBanner =
  | { readonly kind: 'outcome'; readonly level: 'error' | 'warning'; readonly outcome: DownloadOutcomeDto }
  | { readonly kind: 'event'; readonly event: ConversationEventDto };

/**
 * Prefer the **current** outcome (not historic timeline noise). After a successful
 * restart, a previous `pixiv-auth` failure must not keep nagging.
 */
export function resolveResultBanner(
  conversation: Pick<ConversationDetailDto, 'outcome' | 'events' | 'filesCount'>,
  options?: { readonly pixivConnected?: boolean }
): ResultBanner | null {
  const { outcome, events, filesCount } = conversation;
  const pixivConnected = options?.pixivConnected ?? false;

  if (outcome) {
    if (outcome.kind === 'ok') return null;
    // Partial run that still produced files, with a leftover Pixiv auth line in the
    // engine log, while the account is already connected — not an actionable login CTA.
    if (outcome.kind === 'partial' && filesCount > 0 && outcome.reason === 'pixiv-auth' && pixivConnected) {
      return null;
    }
    if (outcome.kind === 'partial' || outcome.kind === 'cancelled') {
      return { kind: 'outcome', level: 'warning', outcome };
    }
    if (outcome.kind === 'error' || outcome.kind === 'empty') {
      return { kind: 'outcome', level: 'error', outcome };
    }
    return null;
  }

  // Active / no outcome yet: only errors from the current attempt (after last restart).
  let from = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && (event.type === 'restarted' || event.code === 'restarted')) {
      from = i + 1;
      break;
    }
  }
  const current = events.slice(from);
  const alert = [...current].reverse().find((event) => event.level === 'error') ?? null;
  return alert ? { kind: 'event', event: alert } : null;
}
