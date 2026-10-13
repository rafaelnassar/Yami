/** SQLite `DownloadRepository` (write side of the downloads aggregate). */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DownloadRecord, DownloadRepository } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import { DOWNLOAD_COLUMNS, downloadColumns, downloadToParams, rowToDownload } from './download-row.ts';
import { mapRow, mapRows } from './row-mapping.ts';

const TABLE = 'downloads';

/**
 * `folder_id` is written on insert only: after that, folder membership is owned
 * by `FolderRepository.assign`, so a stale in-memory record saved by the
 * downloads core can never undo a move the user just made.
 */
const UPDATABLE_COLUMNS = DOWNLOAD_COLUMNS.filter((name) => name !== 'id' && name !== 'folder_id');

export class SqliteDownloadRepository implements DownloadRepository {
  readonly #logger: Logger;
  readonly #get: StatementSync;
  readonly #listActive: StatementSync;
  readonly #upsert: StatementSync;
  readonly #delete: StatementSync;
  readonly #maxPosition: StatementSync;
  readonly #recentUrls: StatementSync;
  readonly #byBatch: StatementSync;

  constructor(db: DatabaseSync, logger: Logger) {
    this.#logger = logger;
    const columns = downloadColumns();
    this.#get = db.prepare(`SELECT ${columns} FROM downloads WHERE id = ?`);
    this.#listActive = db.prepare(
      `SELECT ${columns} FROM downloads WHERE status IN ('pending', 'running', 'paused') ORDER BY position ASC, id ASC`
    );
    this.#upsert = db.prepare(
      `INSERT INTO downloads (${columns}) VALUES (${DOWNLOAD_COLUMNS.map((name) => `:${name}`).join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${UPDATABLE_COLUMNS.map((name) => `${name} = excluded.${name}`).join(', ')}`
    );
    this.#delete = db.prepare('DELETE FROM downloads WHERE id = ?');
    this.#maxPosition = db.prepare('SELECT MAX(position) AS max_position FROM downloads');
    this.#recentUrls = db.prepare(
      `SELECT source_url FROM downloads GROUP BY source_url ORDER BY MAX(created_at) DESC, source_url ASC LIMIT ?`
    );
    this.#byBatch = db.prepare(`SELECT ${columns} FROM downloads WHERE batch_id = ? ORDER BY position ASC, id ASC`);
  }

  get(id: string): DownloadRecord | null {
    return mapRow(this.#get.get(id), rowToDownload, this.#logger, TABLE);
  }

  listActive(): DownloadRecord[] {
    return mapRows(this.#listActive.all(), rowToDownload, this.#logger, TABLE);
  }

  save(record: DownloadRecord): void {
    this.#upsert.run(downloadToParams(record));
  }

  delete(id: string): void {
    this.#delete.run(id);
  }

  nextPosition(): number {
    const max = this.#maxPosition.get()?.['max_position'];
    return typeof max === 'number' ? max + 1 : 0;
  }

  recentSourceUrls(limit: number): string[] {
    const safeLimit = Math.max(0, Math.min(Math.trunc(limit) || 0, 10_000));
    if (safeLimit === 0) return [];
    const urls: string[] = [];
    for (const row of this.#recentUrls.all(safeLimit)) {
      const url = row['source_url'];
      if (typeof url === 'string') urls.push(url);
    }
    return urls;
  }

  listByBatch(batchId: string): DownloadRecord[] {
    return mapRows(this.#byBatch.all(batchId), rowToDownload, this.#logger, TABLE);
  }
}
