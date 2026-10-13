/**
 * Bookkeeping of the legacy (1.x) import across host starts.
 *
 * - "Finished" is recorded twice: the `legacyImport` database marker and the
 *   `<dataDir>/legacy-import.json` file (written atomically). Either one means
 *   the import never runs again — a database recreated after corruption loses
 *   its marker but not the file — and the missing one is restored from the other.
 * - `legacyImport.<step>` markers record steps that must not run twice: repeating
 *   them after a failed attempt would undo choices the user made in between
 *   (a removed cookie, a disconnected account, changed settings).
 * - `legacyImport.failedAttempts` counts runs whose history steps failed; after
 *   `LEGACY_IMPORT_MAX_ATTEMPTS` the import finishes with what it could import.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { v } from '../../../shared/validation/schema.ts';
import type { Logger } from '../../application/ports/system.ts';
import type { InternalMarkers } from '../persistence/settings-repository.ts';
import { describeError } from '../persistence/silent-logger.ts';
import { writeFileAtomic } from '../security/atomic-file.ts';

export const LEGACY_IMPORT_MARKER = 'legacyImport';
export const LEGACY_IMPORT_MARKER_FILE = 'legacy-import.json';
/** Runs whose history steps failed before the import is finished anyway. */
export const LEGACY_IMPORT_MAX_ATTEMPTS = 3;

const ATTEMPTS_MARKER = `${LEGACY_IMPORT_MARKER}.failedAttempts`;
const MAX_MARKER_FILE_BYTES = 4_096;
const MarkerFileSchema = v.object({ importedAt: v.number({ int: true, min: 0 }) }, { strict: false });

/** Steps recorded once done so a retried import skips (or, for cookies, only re-maps) them. */
export type OnceStep = 'cookies' | 'credentials' | 'settings';

export function legacyImportMarkerPath(dataDir: string): string {
  return path.join(dataDir, LEGACY_IMPORT_MARKER_FILE);
}

/**
 * `null` when the file does not exist. A present but unreadable/invalid file
 * still means "imported" (`0`): it is only ever written when the import finished.
 */
export async function readLegacyImportMarkerFile(file: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT' ? null : 0;
  }
  if (raw.length > MAX_MARKER_FILE_BYTES) return 0;
  try {
    const parsed = MarkerFileSchema.parse(JSON.parse(raw));
    return parsed.ok ? parsed.value.importedAt : 0;
  } catch {
    return 0;
  }
}

export function writeLegacyImportMarkerFile(file: string, importedAt: number): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify({ importedAt })}\n`, { mode: 0o600 });
}

export interface LegacyImportProgressOptions {
  readonly markers: InternalMarkers;
  /** `legacyImportMarkerPath(dataDir)`; `null` keeps the record in the database only. */
  readonly markerFile: string | null;
  readonly logger: Logger;
}

export class LegacyImportProgress {
  readonly #markers: InternalMarkers;
  readonly #file: string | null;
  readonly #logger: Logger;

  constructor(options: LegacyImportProgressOptions) {
    this.#markers = options.markers;
    this.#file = options.markerFile;
    this.#logger = options.logger;
  }

  /** True when either record says the import finished; restores the other one (best effort). */
  async isFinished(): Promise<boolean> {
    const inDatabase = this.#markers.get(LEGACY_IMPORT_MARKER);
    const inFile = this.#file ? await readLegacyImportMarkerFile(this.#file) : null;
    if (inDatabase === null && inFile === null) return false;
    if (inDatabase === null && inFile !== null) {
      try {
        this.#markers.set(LEGACY_IMPORT_MARKER, inFile);
        this.#logger.info('legacy import marker restored from the marker file');
      } catch (error) {
        this.#logger.warn('legacy import marker not restored', { error: describeError(error) });
      }
    }
    if (inFile === null && inDatabase !== null) await this.#writeFile(inDatabase);
    return true;
  }

  stepDone(step: OnceStep): boolean {
    return this.#markers.get(`${LEGACY_IMPORT_MARKER}.${step}`) !== null;
  }

  markStep(step: OnceStep, now: number): void {
    this.#markers.set(`${LEGACY_IMPORT_MARKER}.${step}`, now);
  }

  get failedAttempts(): number {
    return this.#markers.get(ATTEMPTS_MARKER) ?? 0;
  }

  /** Returns the new number of failed attempts. */
  recordFailedAttempt(): number {
    const attempts = this.failedAttempts + 1;
    this.#markers.set(ATTEMPTS_MARKER, attempts);
    return attempts;
  }

  async finish(now: number): Promise<void> {
    this.#markers.set(LEGACY_IMPORT_MARKER, now);
    await this.#writeFile(now);
  }

  async #writeFile(importedAt: number): Promise<void> {
    if (!this.#file) return;
    try {
      await writeLegacyImportMarkerFile(this.#file, importedAt);
    } catch (error) {
      // The database marker still prevents a second import while the database is intact.
      this.#logger.warn('legacy import marker file not written', { error: describeError(error) });
    }
  }
}
