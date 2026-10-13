/**
 * Persistence and publication side effects of the downloads core:
 * - `commit`: saves a download and its pending domain events (timeline) atomically;
 * - `publish*`: protocol events for the main process (logs, changes, notices);
 * - `defer`: completion events (`download.finished`, `batch.finished`, notices) are
 *   held until the coordinator has notified the snapshot change of the same pass,
 *   so a `state` showing the download still running never follows its completion.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { ConversationChangeReason, HostEvent } from '../../../shared/contracts/host-protocol.ts';
import type { LogEntryDto, LogLevel, Params } from '../../../shared/contracts/dto.ts';
import type { Download } from '../../domain/downloads/download.ts';
import type { DownloadRecord, PersistenceContext } from '../ports/persistence.ts';
import type { EventSink } from '../ports/system.ts';
import { toConversationEvent } from './conversation-events.ts';
import { toRecord } from './record-mapper.ts';

/** Max items per published `log` / `files.added` event (a big drain is split). */
export const MAX_ITEMS_PER_EVENT = 500;

export interface JournalDeps {
  readonly persistence: PersistenceContext;
  readonly events: EventSink;
  readonly clock: Clock;
}

export class DownloadJournal {
  readonly #persistence: PersistenceContext;
  readonly #events: EventSink;
  readonly #clock: Clock;
  #deferred: HostEvent[] = [];

  constructor(deps: JournalDeps) {
    this.#persistence = deps.persistence;
    this.#events = deps.events;
    this.#clock = deps.clock;
  }

  /**
   * Saves the download and appends its pending domain events as timeline entries in
   * one transaction. Returns the stored record, or `null` when the row no longer
   * exists (deleted concurrently) — the caller must then forget the download
   * instead of resurrecting it. `create` inserts a new row.
   */
  commit(download: Download, options: { readonly create?: boolean } = {}): DownloadRecord | null {
    const { downloads, events, tx } = this.#persistence;
    return tx.transaction(() => {
      const existing = options.create ? null : downloads.get(download.id);
      const pending = download.pullEvents();
      if (!existing && !options.create) return null;
      const record = toRecord(download.toState(), existing, this.#clock.now());
      downloads.save(record);
      for (const event of pending) events.append(toConversationEvent(event, download.engine));
      return record;
    });
  }

  /** True while the download's row exists (a deleted conversation has none). */
  exists(downloadId: string): boolean {
    return this.#persistence.downloads.get(downloadId) !== null;
  }

  publish(event: HostEvent): void {
    this.#events.publish(event);
  }

  /** Queues a completion event until `flushDeferred` (after the snapshot change notification). */
  defer(event: HostEvent): void {
    this.#deferred.push(event);
  }

  get hasDeferred(): boolean {
    return this.#deferred.length > 0;
  }

  flushDeferred(): void {
    const events = this.#deferred;
    this.#deferred = [];
    for (const event of events) this.#events.publish(event);
  }

  changed(conversationId: string, reason: ConversationChangeReason): void {
    this.#events.publish({ type: 'conversation.changed', conversationId, reason });
  }

  /** Host-generated log line (`logs.<code>`). */
  logCode(level: LogLevel, code: string, params: Params, conversationId: string | null = null): void {
    this.logEntries([{ ts: this.#clock.now(), level, text: null, code, params, conversationId }]);
  }

  /** Raw (already redacted) text line, e.g. the engine command line. */
  logText(level: LogLevel, text: string, conversationId: string | null): void {
    this.logEntries([{ ts: this.#clock.now(), level, text, code: null, params: {}, conversationId }]);
  }

  logEntries(entries: readonly LogEntryDto[]): void {
    for (const chunk of chunked(entries)) this.#events.publish({ type: 'log', entries: chunk });
  }
}

/** Splits `items` into chunks of at most `MAX_ITEMS_PER_EVENT`. */
export function chunked<T>(items: readonly T[], size = MAX_ITEMS_PER_EVENT): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
