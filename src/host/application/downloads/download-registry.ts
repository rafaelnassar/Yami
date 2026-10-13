/**
 * In-memory state of the downloads core: active downloads (pending, running,
 * paused), the supervision handles of running ones and the ids forgotten during
 * this host's life. Terminal downloads leave the registry once finished (history
 * lives in persistence).
 */
import type { Download } from '../../domain/downloads/download.ts';
import type { LineParser } from '../ports/engines.ts';
import type { LogReader } from '../ports/files.ts';
import type { ProcessExit } from '../ports/processes.ts';

/** A cookie file decrypted into the job workspace for one run. */
export interface MaterializedCookie {
  readonly name: string;
  readonly file: string;
}

/** Supervision handle of one engine run. */
export interface ActiveRun {
  readonly downloadId: string;
  readonly reader: LogReader;
  readonly parser: LineParser;
  /** Launched by this host instance: exit arrives through `exit`. Re-attached runs are polled instead. */
  readonly launchedHere: boolean;
  /** Download dir the run writes into (relative engine paths resolve against it). */
  readonly downloadDir: string;
  /** Engine output root passed to the engine (`<downloadDir>/<engine>`). */
  readonly outputDir: string;
  /** Private scratch dir of the run (engine temp files are never media), when known. */
  readonly tempDir: string | null;
  readonly cookie: MaterializedCookie | null;
  exit: ProcessExit | null;
  stalePolls: number;
  /** Throttles persistence of counters/offset while running. */
  lastPersistAt: number;
  persistedOffset: number;
}

export class DownloadRegistry {
  readonly #downloads = new Map<string, Download>();
  readonly #runs = new Map<string, ActiveRun>();
  /** Forgotten (deleted) conversations: never adopted, scheduled or commanded again. */
  readonly #forgotten = new Set<string>();

  add(download: Download): void {
    if (this.#forgotten.has(download.id)) return;
    this.#downloads.set(download.id, download);
  }

  get(id: string): Download | undefined {
    return this.#downloads.get(id);
  }

  remove(id: string): void {
    this.#downloads.delete(id);
    this.#runs.delete(id);
  }

  /** Removes the download and remembers that it must never come back. */
  forget(id: string): void {
    this.remove(id);
    this.#forgotten.add(id);
  }

  isForgotten(id: string): boolean {
    return this.#forgotten.has(id);
  }

  /** Every download in memory, in scheduling order. */
  all(): Download[] {
    return [...this.#downloads.values()].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  withStatus(...statuses: readonly Download['status'][]): Download[] {
    return this.all().filter((download) => statuses.includes(download.status));
  }

  runOf(id: string): ActiveRun | undefined {
    return this.#runs.get(id);
  }

  setRun(run: ActiveRun): void {
    this.#runs.set(run.downloadId, run);
  }

  deleteRun(id: string): void {
    this.#runs.delete(id);
  }

  runs(): ActiveRun[] {
    return [...this.#runs.values()];
  }
}
