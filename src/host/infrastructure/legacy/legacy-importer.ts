/**
 * One-time import of the legacy app data (`~/.yami`): history database,
 * `state.json` (settings + active jobs), cookie files and Pixiv credentials.
 *
 * - Legacy files are only read. The single exception is the plaintext secrets
 *   (`cookies/*`, `credentials.json`): when the import finishes, each one is
 *   deleted after reading the same secret back from the encrypted vault
 *   (legacy-secret-cleanup); unproven ones stay and are reported as kept. The
 *   database, `state.json`, `bin/`, `python/` and everything else are never
 *   modified or deleted.
 * - Each conversation (row + files + events) is written in its own transaction
 *   and skipped when it already exists, so an interrupted or failed run can
 *   simply be repeated.
 * - A failing step is logged and reported; the remaining steps still run. When
 *   a history step (`state`, `database`, `downloads`) fails the import is not
 *   finished: it runs again at the next start, up to `LEGACY_IMPORT_MAX_ATTEMPTS`
 *   failed runs, and skips the secrets cleanup so the retry still finds the
 *   cookie files and maps their names. The downloads step waits for the retry
 *   too when its sources (`state.json`, the database) could not be read, since a
 *   retry skips conversations that already exist. Steps that must not repeat are
 *   recorded (legacy-import-progress).
 * - The caller must not run the import while the secrets vault is unavailable
 *   (`pending()` tells whether there is anything to postpone).
 * - A finished import is recorded in the database and in a marker file next to
 *   it, and never repeats.
 */
import { rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { CookieVault, CredentialVault } from '../../application/ports/secrets.ts';
import type { Logger } from '../../application/ports/system.ts';
import { describeError } from '../persistence/silent-logger.ts';
import { importLegacyCookies, type CookieImportResult } from './legacy-cookie-import.ts';
import { LegacyDatabaseReader } from './legacy-database-reader.ts';
import { readLegacyPixiv, readLegacyState, type LegacyState } from './legacy-files.ts';
import { importLegacyDownloads, type DownloadImportCounts, type LegacyImportTarget } from './legacy-downloads.ts';
import { LEGACY_IMPORT_MAX_ATTEMPTS, LegacyImportProgress, type OnceStep } from './legacy-import-progress.ts';
import { removeImportedPlaintextSecrets, type PlaintextCleanupResult } from './legacy-secret-cleanup.ts';
import { mergeLegacySettings } from './legacy-settings.ts';
import { fallbackTitle } from './legacy-mapping.ts';

export type { LegacyImportTarget } from './legacy-downloads.ts';
export { LEGACY_IMPORT_MARKER, LEGACY_IMPORT_MAX_ATTEMPTS, legacyImportMarkerPath } from './legacy-import-progress.ts';

export type LegacyImportStep = 'cookies' | 'database' | 'state' | 'downloads' | 'credentials' | 'settings' | 'cleanup';

/** Steps whose failure leaves the import unfinished (retried at the next start). */
const HISTORY_STEPS: ReadonlySet<LegacyImportStep> = new Set<LegacyImportStep>(['state', 'database', 'downloads']);

export interface LegacyImportReport {
  /**
   * `imported`: finished (never runs again), possibly with `failedSteps`;
   * `incomplete`: history steps failed — runs again at the next start;
   * `already-imported`: finished earlier (nothing was done); `no-legacy-data`: no legacy dir.
   */
  readonly status: 'imported' | 'incomplete' | 'already-imported' | 'no-legacy-data';
  readonly conversations: number;
  /** Active legacy downloads imported as `paused`. */
  readonly pausedDownloads: number;
  readonly batches: number;
  readonly files: number;
  readonly events: number;
  /** Legacy rows/entries that were invalid and skipped. */
  readonly skipped: number;
  readonly cookies: { readonly imported: number; readonly existing: number; readonly invalid: number };
  readonly pixivImported: boolean;
  readonly settingsImported: boolean;
  /** Legacy plaintext secret files deleted after the vault was verified to hold the same secret. */
  readonly plaintextSecretsRemoved: number;
  /**
   * Legacy plaintext secret files left on disk (invalid, not matching the vault, or not deletable):
   * non-hidden files in `cookies/` plus `credentials.json` when it holds a Pixiv token.
   */
  readonly plaintextSecretsKept: number;
  readonly failedSteps: readonly LegacyImportStep[];
  /** Runs (this one included) whose history steps failed; the import finishes at `LEGACY_IMPORT_MAX_ATTEMPTS`. */
  readonly failedAttempts: number;
}

export interface LegacyImporterOptions {
  readonly target: LegacyImportTarget;
  readonly cookies: CookieVault;
  readonly credentials: CredentialVault;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly legacyDir: string | null;
  /** Where the legacy database copy is made (default `os.tmpdir()`); e.g. `HostPaths.tempDir`. */
  readonly workDir?: string;
  /** Validates the legacy download dir (e.g. `PathSandbox.validateDownloadDir`); otherwise only absolute paths are kept. */
  readonly validateDownloadDir?: (dir: string) => Promise<Result<string, AppErrorData>>;
  /** Title for downloads known only from `state.json` (default: the URL host). */
  readonly titleFor?: (url: string) => string;
  /** Deletes a legacy plaintext secret file (default `fs.rm`); injectable to exercise failures. */
  readonly removeFile?: (file: string) => Promise<void>;
  /**
   * `legacyImportMarkerPath(dataDir)`: second "finished" record, outside the database, so a
   * database recreated after corruption does not import again. `null`/absent: database only.
   */
  readonly markerFile?: string | null;
  /** Reads `state.json` (default `readLegacyState`); injectable to exercise failures. */
  readonly readState?: (legacyDir: string) => Promise<LegacyState | null>;
}

const NO_COUNTS: DownloadImportCounts = {
  conversations: 0,
  pausedDownloads: 0,
  batches: 0,
  files: 0,
  events: 0,
  skipped: 0
};

function emptyReport(status: LegacyImportReport['status']): LegacyImportReport {
  return {
    status,
    ...NO_COUNTS,
    cookies: { imported: 0, existing: 0, invalid: 0 },
    pixivImported: false,
    settingsImported: false,
    plaintextSecretsRemoved: 0,
    plaintextSecretsKept: 0,
    failedSteps: [],
    failedAttempts: 0
  };
}

export class LegacyImporter {
  readonly #options: LegacyImporterOptions;
  readonly #logger: Logger;

  constructor(options: LegacyImporterOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'legacy-import' });
  }

  /** True when legacy data exists and its import has not finished (`run()` would import now). */
  async pending(): Promise<boolean> {
    return typeof (await this.#prepare()) !== 'string';
  }

  async #prepare(): Promise<
    { readonly legacyDir: string; readonly progress: LegacyImportProgress } | 'no-legacy-data' | 'already-imported'
  > {
    const { legacyDir, target } = this.#options;
    if (!legacyDir || !(await stat(legacyDir).catch(() => null))?.isDirectory()) return 'no-legacy-data';
    const progress = new LegacyImportProgress({
      markers: target.markers,
      markerFile: this.#options.markerFile ?? null,
      logger: this.#logger
    });
    return (await progress.isFinished()) ? 'already-imported' : { legacyDir, progress };
  }

  async run(): Promise<LegacyImportReport> {
    const prepared = await this.#prepare();
    if (typeof prepared === 'string') return emptyReport(prepared);
    const { legacyDir, progress } = prepared;
    const { target } = this.#options;
    const lastChance = progress.failedAttempts + 1 >= LEGACY_IMPORT_MAX_ATTEMPTS;
    const failed: LegacyImportStep[] = [];
    const step = async <T>(name: LegacyImportStep, work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        failed.push(name);
        this.#logger.error('legacy import step failed', { step: name, error: describeError(error) });
        return fallback;
      }
    };
    /** Runs a step unless an earlier attempt completed it; records it when it succeeds. */
    const once = async <T>(name: OnceStep, work: () => Promise<T>, fallback: T): Promise<T> => {
      if (progress.stepDone(name)) return fallback;
      const result = await step(name, work, fallback);
      if (!failed.includes(name)) progress.markStep(name, this.#options.clock.now());
      return result;
    };

    const noCookies: CookieImportResult = { names: new Map(), imported: 0, existing: 0, invalid: 0 };
    // Always runs: a retry needs the name mapping, but only saves files on the first successful attempt.
    const saveMissing = !progress.stepDone('cookies');
    const cookies = await step(
      'cookies',
      () => importLegacyCookies(legacyDir, this.#options.cookies, this.#logger, { saveMissing }),
      noCookies
    );
    if (saveMissing && !failed.includes('cookies')) progress.markStep('cookies', this.#options.clock.now());
    const readState = this.#options.readState ?? readLegacyState;
    const state = await step<LegacyState | null>('state', () => readState(legacyDir), null);
    const workDir = this.#options.workDir ?? os.tmpdir();
    const reader = await step('database', () => LegacyDatabaseReader.open(legacyDir, workDir), null);
    let counts = NO_COUNTS;
    try {
      // Without the database, active jobs would lose their files and events; without state.json,
      // their cookie, batch and fresher counters. A retry skips existing ids, so unless this is the
      // last attempt, wait for it instead of importing incomplete conversations.
      const sourceFailed = failed.includes('database') || failed.includes('state');
      if (!sourceFailed || lastChance) {
        counts = await step(
          'downloads',
          async () =>
            importLegacyDownloads({
              target,
              reader,
              state,
              cookieNames: cookies.names,
              now: this.#options.clock.now(),
              titleFor: this.#options.titleFor ?? fallbackTitle,
              logger: this.#logger
            }),
          NO_COUNTS
        );
      }
    } finally {
      await reader?.close().catch(() => undefined);
    }
    const pixivImported = await once('credentials', () => this.#importPixiv(legacyDir), false);
    // Settings come from state.json: when it could not be read, leave them to the retry.
    const settingsImported = failed.includes('state')
      ? false
      : await once(
          'settings',
          () =>
            mergeLegacySettings({
              settings: target.settings,
              config: state?.config ?? null,
              cookieNames: cookies.names,
              acceptDownloadDir: (dir) => this.#acceptDownloadDir(dir)
            }),
          false
        );

    const historyFailed = failed.some((name) => HISTORY_STEPS.has(name));
    const failedAttempts = historyFailed ? progress.recordFailedAttempt() : progress.failedAttempts;
    const finished = !historyFailed || failedAttempts >= LEGACY_IMPORT_MAX_ATTEMPTS;
    const noCleanup: PlaintextCleanupResult = { removed: 0, kept: 0 };
    let cleanup = noCleanup;
    if (finished) {
      // Last, and only once nothing is retried: a retry must still find the cookie files.
      cleanup = await step('cleanup', () => this.#removePlaintextSecrets(legacyDir, workDir, cookies.names), noCleanup);
      await progress.finish(this.#options.clock.now());
    }

    const report: LegacyImportReport = {
      status: finished ? 'imported' : 'incomplete',
      ...counts,
      skipped: counts.skipped + (reader?.invalidRows ?? 0) + (state?.invalidEntries ?? 0),
      cookies: { imported: cookies.imported, existing: cookies.existing, invalid: cookies.invalid },
      pixivImported,
      settingsImported,
      plaintextSecretsRemoved: cleanup.removed,
      plaintextSecretsKept: cleanup.kept,
      failedSteps: failed,
      failedAttempts
    };
    this.#logger.info(finished ? 'legacy data imported' : 'legacy import incomplete; retrying at the next start', {
      conversations: report.conversations,
      paused: report.pausedDownloads,
      files: report.files,
      cookies: report.cookies.imported,
      plaintextRemoved: report.plaintextSecretsRemoved,
      plaintextKept: report.plaintextSecretsKept,
      failed: failed.join(','),
      failedAttempts
    });
    return report;
  }

  #removePlaintextSecrets(
    legacyDir: string,
    workDir: string,
    cookieNames: ReadonlyMap<string, string>
  ): Promise<PlaintextCleanupResult> {
    return removeImportedPlaintextSecrets({
      legacyDir,
      workDir,
      cookies: this.#options.cookies,
      credentials: this.#options.credentials,
      cookieNames,
      removeFile: this.#options.removeFile ?? ((file) => rm(file, { force: true })),
      logger: this.#logger
    });
  }

  async #importPixiv(legacyDir: string): Promise<boolean> {
    const legacy = await readLegacyPixiv(legacyDir);
    if (!legacy || (await this.#options.credentials.getPixiv())) return false;
    await this.#options.credentials.savePixiv({
      refreshToken: legacy.refreshToken,
      userName: legacy.userName,
      userId: legacy.userId,
      savedAt: legacy.updatedAt ?? this.#options.clock.now()
    });
    return true;
  }

  async #acceptDownloadDir(dir: string): Promise<string | null> {
    const validate = this.#options.validateDownloadDir;
    if (!validate) return path.isAbsolute(dir) ? dir : null;
    const result = await validate(dir);
    if (result.ok) return result.value;
    this.#logger.warn('legacy download dir rejected', { code: result.error.code });
    return null;
  }
}
