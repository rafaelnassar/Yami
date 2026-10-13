/**
 * Part of the host protocol (main ↔ download host utility process).
 * See `host-protocol.ts` for the transport overview.
 */
import type { AppErrorData } from '../kernel/errors.ts';
import { v, type Infer } from '../validation/schema.ts';
import type {
  BatchFinishedDto,
  DownloadFinishedDto,
  HostStateDto,
  LogEntryDto,
  MediaFileDto,
  NoticeDto,
  RuntimeProgressDto
} from './dto.ts';
import type { CookiesSnapshot, CommandPayload, HostCommand } from './host-commands.ts';

/* ─────────────────────────── Events ─────────────────────────── */

export type ConversationChangeReason = 'created' | 'started' | 'updated' | 'finished' | 'deleted' | 'moved';

export type HostEvent =
  | { readonly type: 'state'; readonly state: HostStateDto }
  | { readonly type: 'log'; readonly entries: readonly LogEntryDto[] }
  | { readonly type: 'files.added'; readonly items: readonly MediaFileDto[] }
  | { readonly type: 'notice'; readonly notice: NoticeDto }
  | { readonly type: 'notice.dismissed'; readonly id: string }
  | { readonly type: 'runtime.progress'; readonly progress: RuntimeProgressDto }
  | {
      readonly type: 'runtime.operationFinished';
      readonly operationId: string;
      readonly ok: boolean;
      readonly error: AppErrorData | null;
    }
  | {
      readonly type: 'conversation.changed';
      readonly conversationId: string;
      readonly reason: ConversationChangeReason;
    }
  | { readonly type: 'download.finished'; readonly download: DownloadFinishedDto }
  | { readonly type: 'batch.finished'; readonly batch: BatchFinishedDto }
  | { readonly type: 'folders.changed' }
  | { readonly type: 'cookies.changed'; readonly cookies: CookiesSnapshot };

export type HostEventType = HostEvent['type'];

/* ─────────────────────────── Envelopes ─────────────────────────── */

export interface RequestEnvelope<C extends HostCommand = HostCommand> {
  readonly kind: 'request';
  readonly id: string;
  readonly command: C;
  readonly payload: CommandPayload<C>;
}

export type ResponseEnvelope =
  | { readonly kind: 'response'; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly kind: 'response'; readonly id: string; readonly ok: false; readonly error: AppErrorData };

export interface EventEnvelope {
  readonly kind: 'event';
  readonly event: HostEvent;
}

/** Host → main message emitted once, as soon as the host process has loaded. */
export interface ReadyEnvelope {
  readonly kind: 'ready';
  readonly pid: number;
}

export type HostToMainMessage = ResponseEnvelope | EventEnvelope | ReadyEnvelope;
export type MainToHostMessage = RequestEnvelope;

export const RequestEnvelopeSchema = v.object({
  kind: v.literal('request'),
  id: v.string({ min: 1, max: 64 }),
  command: v.string({ min: 1, max: 64 }),
  payload: v.unknown()
});

export type RawRequestEnvelope = Infer<typeof RequestEnvelopeSchema>;
