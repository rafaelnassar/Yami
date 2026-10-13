/**
 * How one parsed engine line changes a running download: counters, the last
 * engine error messages and the live progress of the run.
 */
import type { EngineErrorKind, ParsedLine } from '../engines/parsed-line.ts';
import { MAX_ERROR_LINES, type DownloadCounters } from './download-state.ts';
import type { DetectedFile, RunProgress } from './run-progress.ts';

/** What one engine output line changed. */
export interface LineEffect {
  /** Something visible (counters, progress, current file) changed. */
  readonly changed: boolean;
  /** A newly counted file (after per-run de-duplication). */
  readonly file: DetectedFile | null;
}

export const NO_EFFECT: LineEffect = { changed: false, file: null };

/** The persisted part of a download that engine lines update. */
export interface LineAccounting {
  readonly counters: DownloadCounters;
  readonly errorLines: readonly string[];
  readonly lastErrorKind: EngineErrorKind | null;
}

export interface AppliedLine {
  readonly accounting: LineAccounting;
  readonly effect: LineEffect;
}

export function applyParsedLine(line: ParsedLine, accounting: LineAccounting, run: RunProgress): AppliedLine {
  switch (line.kind) {
    case 'noise':
    case 'info':
      return { accounting, effect: NO_EFFECT };
    case 'progress':
      return { accounting, effect: { changed: run.applyProgress(line), file: null } };
    case 'pending-file':
      return { accounting, effect: { changed: run.setPending(line.path), file: null } };
    case 'promote-pending':
      return count(accounting, run.promotePending());
    case 'file':
      return count(accounting, run.detect({ status: line.status, path: line.path }));
    case 'error':
      return {
        accounting: recordError(accounting, line.message, line.errorKind, line.fatal),
        effect: { changed: true, file: null }
      };
  }
}

function count(accounting: LineAccounting, file: DetectedFile | null): AppliedLine {
  if (!file) return { accounting, effect: NO_EFFECT };
  const { counters } = accounting;
  const next =
    file.status === 'downloaded'
      ? { ...counters, done: counters.done + 1 }
      : { ...counters, skipped: counters.skipped + 1 };
  return { accounting: { ...accounting, counters: next }, effect: { changed: true, file } };
}

/** Only fatal errors count: a recovered/non-fatal error does not make the download partial. */
function recordError(
  accounting: LineAccounting,
  message: string,
  kind: EngineErrorKind,
  fatal: boolean
): LineAccounting {
  const errorLines = [...accounting.errorLines, message].slice(-MAX_ERROR_LINES);
  const counters = fatal ? { ...accounting.counters, errors: accounting.counters.errors + 1 } : accounting.counters;
  return { counters, errorLines, lastErrorKind: kind };
}
