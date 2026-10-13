/**
 * Decides the structured outcome of a run that ended on its own (a pause, stop or
 * app quit kills the engine and never reaches this policy).
 *
 * Unlike the legacy app (where one `ERROR:` line failed the whole job and the exit
 * code was ignored), what the run *produced* decides first:
 *
 * | produced (done + skipped) | errors / exit                          | kind    | status    | reason              |
 * |---------------------------|----------------------------------------|---------|-----------|---------------------|
 * | > 0                       | no fatal errors, exit 0 or unknown     | ok      | completed |                     |
 * | > 0                       | fatal errors                           | partial | completed | error kind          |
 * | > 0                       | no fatal errors, abnormal exit         | partial | completed | `exit-code`         |
 * | 0                         | fatal error seen                       | error   | failed    | error kind          |
 * | 0                         | abnormal exit                          | error   | failed    | `exit-code`         |
 * | 0                         | otherwise                              | empty   | failed    | `empty-result`      |
 *
 * An abnormal exit is a known non-zero exit code (detail `exit N`) or the end by a
 * signal (detail `signal SIGKILL`): an engine killed by the antivirus, the OOM
 * killer or the task manager after 50 of 200 files did not finish the job. Both
 * engines exit non-zero only on errors with the flags the app passes (gallery-dl:
 * bit flags of the error classes; yt-dlp: 1 on errors, 2 on usage errors — its
 * intentional 101 is only used by `--max-downloads` / `--break-on-*`, never passed).
 * The exit is unknown (`null`) for re-attached runs, whose exit cannot be observed.
 *
 * Cancellation by the user is `cancelled`; launch failures carry their own reason.
 */
import type { OutcomeKind } from '../../../shared/domain/download.ts';
import type { EngineErrorKind } from '../engines/parsed-line.ts';
import type { DownloadCounters, DownloadOutcome } from './download-state.ts';

/** Reasons produced by the downloads core (engine error kinds are reasons too). */
export const OUTCOME_REASONS = {
  engineMissing: 'engine-missing',
  spawnFailed: 'spawn-failed',
  workspaceFailed: 'workspace-failed',
  cookiesUnavailable: 'cookies-unavailable',
  /** The download's chosen cookie file is in a vault that is disabled (its key could not be loaded). */
  vaultUnavailable: 'vault-unavailable',
  exitCode: 'exit-code',
  emptyResult: 'empty-result',
  unknown: 'unknown'
} as const;

export const LAUNCH_FAILURE_REASONS = [
  OUTCOME_REASONS.engineMissing,
  OUTCOME_REASONS.spawnFailed,
  OUTCOME_REASONS.workspaceFailed,
  OUTCOME_REASONS.cookiesUnavailable,
  OUTCOME_REASONS.vaultUnavailable
] as const;

export type LaunchFailureReason = (typeof LAUNCH_FAILURE_REASONS)[number];

export interface RunResult {
  readonly counters: DownloadCounters;
  readonly lastErrorKind: EngineErrorKind | null;
  /** Last engine error message (redacted), when any. */
  readonly lastErrorLine: string | null;
  /** Exit code when the process was launched by this host instance; `null` when unknown. */
  readonly exitCode: number | null;
  /** Signal that ended the process (POSIX), when launched by this host instance; `null` otherwise. */
  readonly exitSignal: string | null;
}

export function produced(counters: DownloadCounters): number {
  return counters.done + counters.skipped;
}

/** `exit N` / `signal NAME` when the process did not exit normally, `null` otherwise (or unknown). */
export function abnormalExit(run: Pick<RunResult, 'exitCode' | 'exitSignal'>): string | null {
  if (run.exitCode !== null && run.exitCode !== 0) return `exit ${run.exitCode}`;
  if (run.exitSignal) return `signal ${run.exitSignal}`;
  return null;
}

export function decideOutcome(run: RunResult): DownloadOutcome {
  const { counters, lastErrorLine } = run;
  const exit = abnormalExit(run);
  if (produced(counters) > 0) {
    if (counters.errors > 0) return { kind: 'partial', reason: run.lastErrorKind, detail: lastErrorLine };
    if (exit) return { kind: 'partial', reason: OUTCOME_REASONS.exitCode, detail: exit };
    return { kind: 'ok', reason: null, detail: null };
  }
  if (counters.errors > 0) {
    return { kind: 'error', reason: run.lastErrorKind ?? OUTCOME_REASONS.unknown, detail: lastErrorLine };
  }
  if (exit) return { kind: 'error', reason: OUTCOME_REASONS.exitCode, detail: exit };
  return { kind: 'empty', reason: OUTCOME_REASONS.emptyResult, detail: lastErrorLine };
}

export function launchFailureOutcome(reason: LaunchFailureReason, detail: string | null = null): DownloadOutcome {
  return { kind: 'error', reason, detail };
}

export function cancelledOutcome(): DownloadOutcome {
  return { kind: 'cancelled', reason: null, detail: null };
}

export function statusForOutcome(kind: OutcomeKind): 'completed' | 'failed' | 'cancelled' {
  switch (kind) {
    case 'ok':
    case 'partial':
      return 'completed';
    case 'empty':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}
