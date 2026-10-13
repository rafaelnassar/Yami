/**
 * Publishes the "updates available" notice (id `runtime-updates`) when the set of
 * pending updates changes, and dismisses it when nothing is pending. A signature
 * of `tool:latest` pairs avoids re-publishing the same notice after every probe.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { NoticeDto } from '../../../shared/contracts/dto.ts';
import type { ToolStatus } from '../../../shared/domain/runtime.ts';
import type { EventSink } from '../ports/system.ts';
import { TOOL_NAMES } from './progress.ts';

export const RUNTIME_UPDATES_NOTICE_ID = 'runtime-updates';
export const AUTO_INSTALL_NOTICE_ID = 'runtime-auto-install';

export class UpdateNotifier {
  readonly #events: EventSink;
  readonly #clock: Clock;
  /** `null` = never evaluated (the first evaluation always publishes something). */
  #signature: string | null = null;

  constructor(events: EventSink, clock: Clock) {
    this.#events = events;
    this.#clock = clock;
  }

  evaluate(tools: readonly ToolStatus[]): void {
    const pending = tools.filter((t) => t.updateAvailable && t.latestVersion);
    const signature = pending
      .map((t) => `${t.id}:${t.latestVersion}`)
      .sort()
      .join('|');
    if (signature === this.#signature) return;
    this.#signature = signature;
    if (pending.length === 0) {
      this.#events.publish({ type: 'notice.dismissed', id: RUNTIME_UPDATES_NOTICE_ID });
      return;
    }
    this.#events.publish({ type: 'notice', notice: this.#notice(pending) });
  }

  #notice(pending: readonly ToolStatus[]): NoticeDto {
    const first = pending[0];
    const single = pending.length === 1 && first;
    return {
      id: RUNTIME_UPDATES_NOTICE_ID,
      kind: 'info',
      code: 'runtimeUpdatesAvailable',
      params: {
        count: pending.length,
        names: pending.map((t) => TOOL_NAMES[t.id]).join(', '),
        name: single ? TOOL_NAMES[first.id] : null,
        current: single ? (first.version ?? '—') : null,
        latest: single ? first.latestVersion : null
      },
      action: { type: 'runtime-update', tools: pending.map((t) => t.id) },
      ts: this.#clock.now()
    };
  }
}

export function autoInstallFailedNotice(tools: readonly ToolId[], errorCode: string, now: number): NoticeDto {
  return {
    id: AUTO_INSTALL_NOTICE_ID,
    kind: 'error',
    code: 'autoInstallFailed',
    params: { tools: tools.map((t) => TOOL_NAMES[t]).join(', '), error: errorCode },
    // Retrying = updating (installing) exactly the tools that are still missing.
    action: tools.length > 0 ? { type: 'runtime-update', tools: [...tools] } : null,
    ts: now
  };
}
