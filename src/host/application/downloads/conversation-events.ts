/**
 * Maps domain events to persisted conversation timeline entries
 * (`conversationEvents.<code>` i18n keys, see `shared/i18n/messages/conversationEvents.ts`).
 * Params never hold `null`: the translator would leave the placeholder visible.
 */
import type { ConversationEventType, EventLevel, Params } from '../../../shared/contracts/dto.ts';
import type { Engine } from '../../../shared/domain/engine.ts';
import type { DownloadCounters, DownloadOutcome } from '../../domain/downloads/download-state.ts';
import type { DownloadEvent } from '../../domain/downloads/events.ts';
import { OUTCOME_REASONS } from '../../domain/downloads/outcome-policy.ts';
import type { NewConversationEvent } from '../ports/persistence.ts';

interface EventShape {
  readonly type: ConversationEventType;
  readonly level: EventLevel;
  readonly code: string;
  readonly params: Params;
}

function shape(type: ConversationEventType, level: EventLevel, code: string, params: Params = {}): EventShape {
  return { type, level, code, params };
}

/** Timeline entry for a finished run; the code depends on the outcome and its reason. */
export function finishedEventShape(outcome: DownloadOutcome, counters: DownloadCounters, engine: Engine): EventShape {
  const detail = outcome.detail ?? '';
  switch (outcome.kind) {
    case 'ok':
      return shape('completed', 'success', 'completed', { done: counters.done, skipped: counters.skipped });
    case 'partial':
      // No error line, but the engine was killed or failed: some files are missing.
      if (outcome.reason === OUTCOME_REASONS.exitCode) {
        return shape('completed', 'warning', 'completedInterrupted', {
          done: counters.done,
          skipped: counters.skipped,
          detail
        });
      }
      return shape('completed', 'warning', 'completedWithErrors', {
        done: counters.done,
        skipped: counters.skipped,
        errors: counters.errors
      });
    case 'empty':
      return shape('failed', 'error', 'failedEmpty', { detail });
    case 'cancelled':
      return shape('cancelled', 'warning', 'cancelled');
    case 'error':
      switch (outcome.reason) {
        case OUTCOME_REASONS.engineMissing:
          return shape('failed', 'error', 'failedEngineMissing', { engine });
        case OUTCOME_REASONS.spawnFailed:
        case OUTCOME_REASONS.workspaceFailed:
          return shape('failed', 'error', 'failedToStart', { detail });
        case OUTCOME_REASONS.cookiesUnavailable:
          return shape('failed', 'error', 'failedCookies', { detail });
        case OUTCOME_REASONS.vaultUnavailable:
          return shape('failed', 'error', 'failedVault', { detail });
        case OUTCOME_REASONS.exitCode:
          return shape('failed', 'error', 'failedExitCode', { detail });
        default:
          return shape('failed', 'error', 'failed', { reason: outcome.reason ?? OUTCOME_REASONS.unknown, detail });
      }
  }
}

function eventShape(event: DownloadEvent, engine: Engine): EventShape {
  switch (event.type) {
    case 'created':
      return shape('created', 'info', 'created');
    case 'started':
      return shape('started', 'info', 'started', { engine: event.engine });
    case 'paused':
      if (event.cause === 'shutdown') return shape('paused', 'warning', 'pausedOnExit');
      if (event.cause === 'recovery') return shape('paused', 'warning', 'pausedUnsupervised');
      if (event.cause === 'vault') return shape('paused', 'warning', 'pausedVaultUnavailable');
      return shape('paused', 'warning', event.wasRunning ? 'paused' : 'pausedBeforeStart');
    case 'resumed':
      return shape('resumed', 'info', 'resumed');
    case 'cancelled':
      return shape('cancelled', 'warning', event.wasRunning ? 'interrupted' : 'cancelled');
    case 'restarted':
      return shape('restarted', 'info', 'restarted');
    case 'retry-scheduled':
      return shape('retry', 'info', event.mode === 'skip' ? 'retryWithoutBrowserCookies' : 'retryWithBrowserCookies');
    case 'finished':
      return finishedEventShape(event.outcome, event.counters, engine);
  }
}

/** `engine` is the download's engine (finished events do not carry it). */
export function toConversationEvent(event: DownloadEvent, engine: Engine): NewConversationEvent {
  const { type, level, code, params } = eventShape(event, engine);
  return { conversationId: event.downloadId, type, level, code, params, createdAt: event.at };
}
