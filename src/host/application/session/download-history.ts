/**
 * `downloads.history` (main-only) — recent distinct source URLs, used by main's
 * clipboard watcher to suggest links from sites the user already downloads from.
 */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadRepository } from '../ports/persistence.ts';

export class DownloadHistoryService {
  readonly #downloads: Pick<DownloadRepository, 'recentSourceUrls'>;

  constructor(downloads: Pick<DownloadRepository, 'recentSourceUrls'>) {
    this.#downloads = downloads;
  }

  history(payload: CommandPayload<'downloads.history'>): Result<CommandResult<'downloads.history'>, AppErrorData> {
    return ok({ sourceUrls: this.#downloads.recentSourceUrls(payload.limit) });
  }
}
