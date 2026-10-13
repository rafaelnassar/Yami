/** `conversations.rename` — user-chosen title (kept across later runs of the download). */
import { LIMITS, type CommandPayload, type CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadRepository } from '../ports/persistence.ts';
import type { EventSink } from '../ports/system.ts';

/** Trims, collapses whitespace runs and caps the length; `null` when nothing is left. */
export function normalizeTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxTitleLength).trim();
  return title.length > 0 ? title : null;
}

export class RenameConversationService {
  readonly #downloads: Pick<DownloadRepository, 'get' | 'save'>;
  readonly #events: EventSink;
  readonly #clock: Clock;

  constructor(downloads: Pick<DownloadRepository, 'get' | 'save'>, events: EventSink, clock: Clock) {
    this.#downloads = downloads;
    this.#events = events;
    this.#clock = clock;
  }

  rename(payload: CommandPayload<'conversations.rename'>): Result<CommandResult<'conversations.rename'>, AppErrorData> {
    const title = normalizeTitle(payload.title);
    if (title === null) return err(appError(ErrorCode.TITLE_REQUIRED));
    const record = this.#downloads.get(payload.conversationId);
    if (!record) return err(appError(ErrorCode.CONVERSATION_NOT_FOUND, { conversationId: payload.conversationId }));
    if (record.title !== title) {
      this.#downloads.save({ ...record, title, updatedAt: this.#clock.now() });
      this.#events.publish({ type: 'conversation.changed', conversationId: record.id, reason: 'updated' });
    }
    return ok({ conversationId: record.id, title });
  }
}
