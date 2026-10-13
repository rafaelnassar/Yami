/**
 * Domain events raised by the `Download` aggregate. The application layer turns
 * them into persisted conversation events and protocol events.
 */
import type { Engine } from '../../../shared/domain/engine.ts';
import type { CookieRetryMode, DownloadCounters, DownloadOutcome } from './download-state.ts';

/**
 * Why a download was paused (or put back in the queue):
 * - `user`: pause command;
 * - `shutdown`: the app quit while it ran (it goes back to the queue and resumes on next launch);
 * - `recovery`: a restarted host could not supervise it again (paused so it never runs unsupervised);
 * - `vault`: the cookie file chosen for it is in a disabled vault (key unavailable, often
 *   temporarily): it waits, with its partial files, to be resumed once the vault works.
 */
export type PauseCause = 'user' | 'shutdown' | 'recovery' | 'vault';

export type DownloadEvent =
  | { readonly type: 'created'; readonly downloadId: string; readonly at: number }
  | { readonly type: 'started'; readonly downloadId: string; readonly engine: Engine; readonly at: number }
  | {
      readonly type: 'paused';
      readonly downloadId: string;
      readonly wasRunning: boolean;
      readonly cause: PauseCause;
      readonly at: number;
    }
  | { readonly type: 'resumed'; readonly downloadId: string; readonly at: number }
  | { readonly type: 'cancelled'; readonly downloadId: string; readonly wasRunning: boolean; readonly at: number }
  | { readonly type: 'restarted'; readonly downloadId: string; readonly at: number }
  | {
      readonly type: 'retry-scheduled';
      readonly downloadId: string;
      readonly mode: CookieRetryMode;
      readonly at: number;
    }
  | {
      readonly type: 'finished';
      readonly downloadId: string;
      readonly status: 'completed' | 'failed';
      readonly outcome: DownloadOutcome;
      readonly counters: DownloadCounters;
      readonly at: number;
    };

export type DownloadEventType = DownloadEvent['type'];
