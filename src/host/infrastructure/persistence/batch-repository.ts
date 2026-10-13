/** SQLite `BatchRepository`. */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { BatchRecord, BatchRepository } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import { mapRow } from './row-mapping.ts';
import { BatchRowSchema } from './row-schemas.ts';

function rowToBatch(row: unknown): Result<BatchRecord, string> {
  const parsed = BatchRowSchema.parse(row);
  if (!parsed.ok) return err(`${parsed.error.path}: ${parsed.error.reason}`);
  const r = parsed.value;
  return ok({
    id: r.id,
    engine: r.engine,
    scope: r.scope,
    total: r.total,
    createdAt: r.created_at,
    notifiedAt: r.notified_at
  });
}

export class SqliteBatchRepository implements BatchRepository {
  readonly #logger: Logger;
  readonly #get: StatementSync;
  readonly #upsert: StatementSync;

  constructor(db: DatabaseSync, logger: Logger) {
    this.#logger = logger;
    this.#get = db.prepare('SELECT id, engine, scope, total, created_at, notified_at FROM batches WHERE id = ?');
    this.#upsert = db.prepare(
      `INSERT INTO batches (id, engine, scope, total, created_at, notified_at)
       VALUES (:id, :engine, :scope, :total, :created_at, :notified_at)
       ON CONFLICT(id) DO UPDATE SET engine = excluded.engine, scope = excluded.scope, total = excluded.total,
         created_at = excluded.created_at, notified_at = excluded.notified_at`
    );
  }

  get(id: string): BatchRecord | null {
    return mapRow(this.#get.get(id), rowToBatch, this.#logger, 'batches');
  }

  save(record: BatchRecord): void {
    this.#upsert.run({
      id: record.id,
      engine: record.engine,
      scope: record.scope,
      total: record.total,
      created_at: record.createdAt,
      notified_at: record.notifiedAt
    });
  }
}
