/**
 * Ends runs and completes terminal transitions:
 * drain the log → decide the outcome → cookie retry (requeue) or finish →
 * persist + timeline → `download.finished` / notice / `batch.finished` (once,
 * deferred: the coordinator publishes them after notifying the snapshot change)
 * → retire the job workspace (temp files removed, log compacted).
 * A retry WITH browser cookies is only ever scheduled when the user opted in.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { ConversationChangeReason } from '../../../shared/contracts/host-protocol.ts';
import type { LogLevel } from '../../../shared/contracts/dto.ts';
import { nextCookieRetry } from '../../domain/downloads/cookie-retry-policy.ts';
import type { Download } from '../../domain/downloads/download.ts';
import { decideOutcome, launchFailureOutcome, OUTCOME_REASONS } from '../../domain/downloads/outcome-policy.ts';
import type { JobWorkspace } from '../ports/files.ts';
import type { DownloadRecord, HostSettingsRepository } from '../ports/persistence.ts';
import type { CookieVault } from '../ports/secrets.ts';
import type { Logger } from '../ports/system.ts';
import type { BatchTracker } from './batch-tracker.ts';
import type { ActiveRun, DownloadRegistry } from './download-registry.ts';
import type { DownloadJournal } from './journal.ts';
import type { LaunchFailure } from './launch-service.ts';
import type { LineProcessor } from './line-processor.ts';
import type { Redactor } from './redactor.ts';

export interface FinisherDeps {
  readonly registry: DownloadRegistry;
  readonly journal: DownloadJournal;
  readonly lines: LineProcessor;
  readonly workspace: JobWorkspace;
  readonly cookieVault: CookieVault;
  readonly batches: BatchTracker;
  readonly settings: HostSettingsRepository;
  readonly redactor: Redactor;
  readonly clock: Clock;
  readonly logger: Logger;
  /** True while a launch of the download is in flight (its engine may start writing the log). */
  readonly isLaunching: (downloadId: string) => boolean;
}

export type FinishResult = 'finished' | 'requeued';

export class Finisher {
  readonly #deps: FinisherDeps;

  constructor(deps: FinisherDeps) {
    this.#deps = deps;
  }

  /** The engine process is gone: account for the rest of its output and settle the download. */
  async finishRun(download: Download, run: ActiveRun | undefined): Promise<FinishResult> {
    if (run) await this.#drain(download, run);
    const outcome = decideOutcome({
      counters: download.counters,
      lastErrorKind: download.lastErrorKind,
      lastErrorLine: download.lastErrorLine,
      exitCode: run?.exit?.code ?? null,
      exitSignal: run?.exit?.signal ?? null
    });
    const retry = nextCookieRetry({
      engine: download.engine,
      outcomeKind: outcome.kind,
      errorKind: download.lastErrorKind,
      usedBrowserCookies: download.usedBrowserCookies,
      browserCookiesOptIn: this.#browserCookiesOptIn(),
      retry: download.retry
    });
    const now = this.#deps.clock.now();
    if (retry) {
      // The failed attempt's cookie changes are discarded (legacy behavior).
      if (run) await this.release(download.id, run, { absorbCookie: false });
      download.requeueForRetry(retry, now);
      if (!this.#commit(download)) return 'requeued';
      const code = retry === 'skip' ? 'retryWithoutBrowserCookies' : 'retryWithBrowserCookies';
      this.#deps.journal.logCode('info', code, { url: this.#url(download) }, download.id);
      this.#deps.journal.changed(download.id, 'updated');
      return 'requeued';
    }
    if (run) await this.release(download.id, run, { absorbCookie: true });
    download.finish(outcome, now);
    await this.completeTerminal(download, 'finished');
    return 'finished';
  }

  /**
   * A pending download could not be launched: it fails — except when its chosen cookie
   * file is in a disabled vault (`vault-unavailable`). A locked keychain is often
   * temporary, so it is paused instead: non-terminal, its temp dir (partial files) is kept
   * and it continues when resumed with a working vault.
   */
  async finishLaunchFailure(download: Download, failure: LaunchFailure): Promise<void> {
    if (failure.reason === OUTCOME_REASONS.vaultUnavailable) {
      this.#holdForVault(download, failure.detail);
      return;
    }
    download.finish(launchFailureOutcome(failure.reason, failure.detail), this.#deps.clock.now());
    await this.completeTerminal(download, 'finished');
  }

  #holdForVault(download: Download, cookieName: string | null): void {
    const now = this.#deps.clock.now();
    const paused = download.pause(now, 'vault');
    if (!paused.ok) {
      this.#deps.logger.warn('could not pause a download waiting for the vault', { downloadId: download.id });
      return;
    }
    const record = this.#commit(download);
    if (!record) return;
    const { journal } = this.#deps;
    journal.changed(download.id, 'updated');
    journal.defer({
      type: 'notice',
      notice: {
        id: `download-vault-${download.id}`,
        kind: 'warn',
        code: 'downloadWaitingVault',
        params: { engine: download.engine, title: record.title, cookie: cookieName ?? '' },
        action: null,
        ts: now
      }
    });
  }

  /** After a successful kill: record what the run printed before dying, then release it. */
  async drainAndRelease(download: Download, run: ActiveRun | undefined): Promise<void> {
    if (!run) return;
    await this.#drain(download, run);
    await this.release(download.id, run, { absorbCookie: true });
  }

  /**
   * Closes the log reader, commits engine cookie updates and removes the run's
   * plaintext secrets. Engine temp files (partial downloads) and the log stay: a
   * later run continues them, and `retire` removes them once the download ends.
   */
  async release(downloadId: string, run: ActiveRun, options: { readonly absorbCookie: boolean }): Promise<void> {
    const { cookieVault, workspace, registry, logger } = this.#deps;
    if (registry.runOf(downloadId) === run) registry.deleteRun(downloadId);
    await run.reader
      .close()
      .catch((error: unknown) => logger.warn('log reader close failed', { error: String(error) }));
    if (options.absorbCookie && run.cookie) {
      await cookieVault
        .absorb(run.cookie.name, run.cookie.file)
        .catch((error: unknown) => logger.warn('cookie absorb failed', { downloadId, error: String(error) }));
    }
    await workspace
      .removeSecrets(downloadId)
      .catch((error: unknown) => logger.warn('job workspace cleanup failed', { downloadId, error: String(error) }));
  }

  /**
   * The download ended or was forgotten: wipes its private workspace (secrets and
   * temp files) and compacts its log, or removes it with `removeLog` — and whenever
   * its row is gone (deleted concurrently), since nothing can show that log again.
   * Callers make sure no engine of the download can still write the log.
   */
  async retire(downloadId: string, options: { readonly removeLog?: boolean } = {}): Promise<void> {
    const { workspace, logger } = this.#deps;
    const removeLog = options.removeLog === true || !this.#rowExists(downloadId);
    await workspace
      .cleanup(downloadId, { removeLog })
      .catch((error: unknown) => logger.warn('job workspace cleanup failed', { downloadId, error: String(error) }));
  }

  /**
   * Persists a terminal download, announces its completion, settles its batch and
   * retires its workspace. Completion events are deferred until the coordinator
   * notified the snapshot change.
   */
  async completeTerminal(download: Download, reason: ConversationChangeReason): Promise<void> {
    const { registry, batches, journal, clock } = this.#deps;
    const record = this.#commit(download);
    registry.remove(download.id);
    batches.update(download.batchId, { id: download.id, status: download.status, counters: download.counters });
    if (record) {
      this.#announceCompletion(download, record);
      journal.changed(download.id, reason);
      const summary = batches.settle(download.batchId, clock.now());
      if (summary) journal.defer({ type: 'batch.finished', batch: summary });
    }
    // Stopped while launching: the launch commit retires it once the unwanted engine is
    // gone. If that engine cannot be killed, the job is left as is (the engine keeps
    // writing its log): the next start-up sweep removes the job dir, the log stays whole.
    if (this.#deps.isLaunching(download.id)) return;
    await this.retire(download.id);
  }

  #announceCompletion(download: Download, record: DownloadRecord): void {
    const { journal, clock } = this.#deps;
    const outcome = download.outcome;
    const url = this.#url(download);
    if (download.status === 'cancelled' || !outcome) {
      journal.logCode('warn', 'cancelled', { url }, download.id);
      return;
    }
    const status = download.status === 'completed' ? 'completed' : 'failed';
    const completedAt = download.completedAt ?? clock.now();
    journal.defer({
      type: 'download.finished',
      download: {
        conversationId: download.id,
        batchId: download.batchId,
        sourceUrl: download.sourceUrl,
        title: record.title,
        engine: download.engine,
        status,
        outcome,
        counters: download.counters,
        completedAt
      }
    });
    const [level, code]: [LogLevel, string] =
      outcome.kind === 'ok'
        ? ['success', 'finished']
        : outcome.kind === 'partial'
          ? ['warn', 'finishedWithErrors']
          : ['error', 'failed'];
    journal.logCode(level, code, { url }, download.id);
    if (status === 'failed') {
      journal.defer({
        type: 'notice',
        notice: {
          id: `download-failed-${download.id}`,
          kind: 'error',
          code: 'downloadFailed',
          params: {
            engine: download.engine,
            title: record.title,
            reason: outcome.reason ?? '',
            detail: outcome.detail ?? ''
          },
          action: null,
          ts: completedAt
        }
      });
    }
  }

  async #drain(download: Download, run: ActiveRun): Promise<void> {
    let lines: string[] = [];
    try {
      lines = await run.reader.drain();
    } catch (error) {
      this.#deps.logger.warn('log drain failed', { downloadId: download.id, error: String(error) });
    }
    await this.#deps.lines.process(download, run, lines);
  }

  /** Saves the download; a vanished row (deleted concurrently) drops it from memory. */
  #commit(download: Download): DownloadRecord | null {
    const record = this.#deps.journal.commit(download);
    if (!record) {
      this.#deps.registry.remove(download.id);
      this.#deps.logger.warn('download row vanished; dropping it', { downloadId: download.id });
    }
    return record;
  }

  /** Unknown (storage error) counts as existing: never drop a log that may still be shown. */
  #rowExists(downloadId: string): boolean {
    try {
      return this.#deps.journal.exists(downloadId);
    } catch (error) {
      this.#deps.logger.warn('download row lookup failed', { downloadId, error: String(error) });
      return true;
    }
  }

  #url(download: Download): string {
    return this.#deps.redactor.text(download.sourceUrl);
  }

  #browserCookiesOptIn(): boolean {
    try {
      return this.#deps.settings.load().cookies.fromBrowser;
    } catch (error) {
      this.#deps.logger.warn('settings unavailable; assuming no browser cookie opt-in', { error: String(error) });
      return false;
    }
  }
}
