/**
 * Composition of the SQLite persistence adapter: opens (or recovers) the
 * database and wires every repository/query of `PersistenceContext` on one
 * connection. Created once by the host composition root.
 */
import path from 'node:path';
import { systemClock, type Clock } from '../../../shared/kernel/clock.ts';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { PersistenceContext } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import { SqliteBatchRepository } from './batch-repository.ts';
import { SqliteConversationQueries } from './conversation-queries.ts';
import { SqliteDownloadRepository } from './download-repository.ts';
import { SqliteConversationEventRepository } from './event-repository.ts';
import { SqliteFolderRepository } from './folder-repository.ts';
import { SqliteMediaFileRepository } from './media-file-repository.ts';
import { SqliteSettingsStore, type InternalMarkers } from './settings-repository.ts';
import type { SalvageReport } from './database-salvage.ts';
import { silentLogger } from './silent-logger.ts';
import { DATABASE_FILE_NAME, openSqliteDatabase } from './sqlite-database.ts';
import { SqliteTransactionRunner } from './transaction-runner.ts';

export interface SqlitePersistenceOptions {
  readonly dataDir: string;
  readonly platform: HostPlatform;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/** `PersistenceContext` plus infrastructure-only capabilities (legacy import). */
export interface SqlitePersistenceContext extends PersistenceContext {
  readonly events: SqliteConversationEventRepository;
  /** Internal bookkeeping markers (e.g. `legacyImport`). */
  readonly markers: InternalMarkers;
}

export interface SqlitePersistence {
  readonly context: SqlitePersistenceContext;
  /** The database was corrupted and has been recreated (the old file was kept at `backupPath`). */
  readonly recovered: boolean;
  readonly backupPath: string | null;
  /** Rows copied from the corrupted database into the new one (`null` unless `recovered`). */
  readonly salvage: SalvageReport | null;
}

export function createSqlitePersistence(options: SqlitePersistenceOptions): SqlitePersistence {
  const logger = (options.logger ?? silentLogger()).child({ component: 'sqlite' });
  const clock = options.clock ?? systemClock;
  const opened = openSqliteDatabase({
    file: path.join(options.dataDir, DATABASE_FILE_NAME),
    logger,
    now: () => clock.now()
  });
  const { db } = opened;
  const tx = new SqliteTransactionRunner(db);
  const files = new SqliteMediaFileRepository({ db, tx, logger, platform: options.platform });
  const settings = new SqliteSettingsStore(db, logger);
  let closed = false;

  const context: SqlitePersistenceContext = {
    downloads: new SqliteDownloadRepository(db, logger),
    batches: new SqliteBatchRepository(db, logger),
    files,
    events: new SqliteConversationEventRepository(db),
    folders: new SqliteFolderRepository(db, tx, logger),
    settings,
    markers: settings,
    conversations: new SqliteConversationQueries(db, files, logger),
    tx,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        // Folds the WAL back into the main file so a copied/backed-up db is complete.
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        logger.warn('wal checkpoint failed on close', { error: String(error) });
      }
      db.close();
    }
  };
  return { context, recovered: opened.recovered, backupPath: opened.backupPath, salvage: opened.salvage };
}
