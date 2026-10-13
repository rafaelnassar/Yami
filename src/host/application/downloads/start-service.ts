/**
 * `start`: validates the request, then creates the batch, its downloads, their
 * timeline `created` entries and folder assignment in one transaction.
 * Scheduling happens afterwards (the caller requests it).
 */
import { appError, ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { DOWNLOAD_SCOPES, isEngine } from '../../../shared/domain/engine.ts';
import { parseHttpUrl, stripUrlSecrets } from '../../../shared/domain/url.ts';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import { Download } from '../../domain/downloads/download.ts';
import { titleFromUrl } from '../../domain/downloads/title.ts';
import type { BatchRecord, PersistenceContext } from '../ports/persistence.ts';
import type { ToolRegistry } from '../ports/runtime.ts';
import type { Logger } from '../ports/system.ts';
import type { BatchTracker } from './batch-tracker.ts';
import type { IdGenerator } from './coordinator-deps.ts';
import type { DownloadRegistry } from './download-registry.ts';
import type { StartDownloadsInput, StartDownloadsOutput } from './downloads-facade.ts';
import type { DownloadJournal } from './journal.ts';

export interface StartServiceDeps {
  readonly persistence: PersistenceContext;
  readonly registry: DownloadRegistry;
  readonly batches: BatchTracker;
  readonly journal: DownloadJournal;
  readonly tools: ToolRegistry;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

function invalid(path: string): Result<never, AppErrorData> {
  return err(appError(ErrorCode.VALIDATION_FAILED, { path }));
}

/** Defense in depth: the protocol layer validates too, but the facade may be called directly. */
function validate(input: StartDownloadsInput): Result<readonly string[], AppErrorData> {
  if (!Array.isArray(input.urls) || input.urls.length === 0) return invalid('urls');
  if (input.urls.length > LIMITS.maxUrlsPerBatch) {
    return err(appError(ErrorCode.URL_LIMIT_EXCEEDED, { max: LIMITS.maxUrlsPerBatch }));
  }
  const urls: string[] = [];
  for (const raw of input.urls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!parseHttpUrl(url)) return err(appError(ErrorCode.URL_INVALID, { url: stripUrlSecrets(url).slice(0, 200) }));
    urls.push(url);
  }
  if (!isEngine(input.engine)) return invalid('engine');
  if (!(DOWNLOAD_SCOPES as readonly string[]).includes(input.scope)) return invalid('scope');
  if (input.cookieNames !== null && (!Array.isArray(input.cookieNames) || input.cookieNames.length > urls.length)) {
    return invalid('cookieNames');
  }
  return ok(urls);
}

export class StartService {
  readonly #deps: StartServiceDeps;

  constructor(deps: StartServiceDeps) {
    this.#deps = deps;
  }

  start(input: StartDownloadsInput): Result<StartDownloadsOutput, AppErrorData> {
    const validated = validate(input);
    if (!validated.ok) return validated;
    const urls = validated.value;
    const { persistence, registry, batches, journal, tools, ids, clock } = this.#deps;
    if (!tools.resolveEngine(input.engine))
      return err(appError(ErrorCode.ENGINE_UNAVAILABLE, { engine: input.engine }));

    const folderId = this.#existingFolder(input.folderId);
    const now = clock.now();
    const batch: BatchRecord = {
      id: ids('b-'),
      engine: input.engine,
      scope: input.scope,
      total: urls.length,
      createdAt: now,
      notifiedAt: null
    };
    const downloads = persistence.tx.transaction(() => {
      persistence.batches.save(batch);
      const base = persistence.downloads.nextPosition();
      const created = urls.map((url, index) =>
        Download.create({
          id: ids(),
          batchId: batch.id,
          sourceUrl: url,
          title: titleFromUrl(url),
          engine: input.engine,
          scope: input.scope,
          cookieName: input.cookieNames?.[index] ?? null,
          folderId,
          position: base + index,
          now
        })
      );
      for (const download of created) journal.commit(download, { create: true });
      if (folderId)
        persistence.folders.assign(
          created.map((download) => download.id),
          folderId
        );
      return created;
    });

    for (const download of downloads) registry.add(download);
    batches.add(
      batch,
      downloads.map((download) => ({ id: download.id, status: download.status, counters: download.counters }))
    );
    for (const download of downloads) journal.changed(download.id, 'created');
    journal.logCode('info', 'queued', { count: downloads.length, engine: input.engine });
    return ok({ batchId: batch.id, conversationIds: downloads.map((download) => download.id) });
  }

  /** A stale folder selection must not block the download: it is ignored. */
  #existingFolder(folderId: string | null): string | null {
    if (!folderId) return null;
    if (this.#deps.persistence.folders.get(folderId)) return folderId;
    this.#deps.logger.warn('start: folder not found, ignoring', { folderId });
    return null;
  }
}
