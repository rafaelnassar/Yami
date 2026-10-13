/**
 * Transient bookkeeping of one engine run: live progress, per-run de-duplication
 * of detected files and the yt-dlp "pending destination" that becomes final once
 * post-processing ends. Never persisted.
 */
import type { ParsedLine } from '../engines/parsed-line.ts';
import { EMPTY_PROGRESS, type DownloadProgress } from './download-state.ts';

export interface DetectedFile {
  readonly status: 'downloaded' | 'skipped';
  /** Path as handed to the aggregate (the application makes it absolute beforehand). */
  readonly path: string;
}

export class RunProgress {
  #progress: DownloadProgress = EMPTY_PROGRESS;
  /** `${status}:${path}` and plain paths seen in this run. */
  #seen = new Set<string>();
  /** Files already counted as `done` by a previous attempt (resume / re-attach). */
  #carried = new Set<string>();
  #pendingFile: string | null = null;
  #pendingPromoted = false;

  get progress(): DownloadProgress {
    return this.#progress;
  }

  /** Starts a new run. `carriedFiles` are ignored when detected again (already counted). */
  reset(carriedFiles: Iterable<string> = []): void {
    this.#progress = EMPTY_PROGRESS;
    this.#seen = new Set();
    this.#carried = new Set(carriedFiles);
    this.#pendingFile = null;
    this.#pendingPromoted = false;
  }

  /** Clears live progress (the run ended); de-dup state is kept until the next `reset`. */
  clearProgress(): void {
    this.#progress = EMPTY_PROGRESS;
  }

  /** Applies a progress line; returns true when something visible changed. */
  applyProgress(line: Extract<ParsedLine, { kind: 'progress' }>): boolean {
    const percent = line.percent === null ? null : Math.min(100, Math.max(0, line.percent));
    const before = this.#progress;
    this.#progress = { ...before, percent, speed: line.speed, eta: line.eta };
    return (
      floorOrNull(before.percent) !== floorOrNull(percent) || before.speed !== line.speed || before.eta !== line.eta
    );
  }

  /** yt-dlp announced a destination that is not final yet. */
  setPending(path: string): boolean {
    this.#pendingFile = path;
    this.#pendingPromoted = false;
    return this.#setCurrentFile(path);
  }

  /** Post-processing finished: the pending destination (if any, not yet promoted) is now a file. */
  promotePending(): DetectedFile | null {
    if (this.#pendingFile === null || this.#pendingPromoted) return null;
    return this.detect({ status: 'downloaded', path: this.#pendingFile });
  }

  /**
   * Registers a detection. Returns `null` when it must not be counted: a repeat
   * within this run (a path first seen as skipped is never re-counted as downloaded)
   * or a file already counted by a previous attempt.
   */
  detect(file: DetectedFile): DetectedFile | null {
    if (this.#carried.has(file.path)) return null;
    const key = `${file.status}:${file.path}`;
    if (this.#seen.has(key) || this.#seen.has(file.path)) return null;
    this.#seen.add(key);
    this.#seen.add(file.path);
    if (file.status === 'downloaded') this.#pendingPromoted = true;
    this.#setCurrentFile(file.path);
    return file;
  }

  #setCurrentFile(path: string): boolean {
    if (this.#progress.currentFile === path) return false;
    this.#progress = { ...this.#progress, currentFile: path };
    return true;
  }
}

function floorOrNull(value: number | null): number | null {
  return value === null ? null : Math.floor(value);
}
