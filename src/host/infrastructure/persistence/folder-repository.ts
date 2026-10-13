/** SQLite `FolderRepository` (sidebar folders of the conversation history). */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { FolderDto } from '../../../shared/contracts/dto.ts';
import type { FolderRepository, TransactionRunner } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import { chunk, mapRow, mapRows, placeholders } from './row-mapping.ts';
import { FolderRowSchema } from './row-schemas.ts';

const COLUMNS = 'id, name, color, collapsed, position, created_at';

function rowToFolder(row: unknown): Result<FolderDto, string> {
  const parsed = FolderRowSchema.parse(row);
  if (!parsed.ok) return err(`${parsed.error.path}: ${parsed.error.reason}`);
  const r = parsed.value;
  return ok({
    id: r.id,
    name: r.name,
    color: r.color,
    collapsed: r.collapsed === 1,
    position: r.position,
    createdAt: r.created_at
  });
}

export class SqliteFolderRepository implements FolderRepository {
  readonly #db: DatabaseSync;
  readonly #tx: TransactionRunner;
  readonly #logger: Logger;
  readonly #list: StatementSync;
  readonly #get: StatementSync;
  readonly #upsert: StatementSync;
  readonly #delete: StatementSync;
  readonly #unassignAll: StatementSync;
  readonly #maxPosition: StatementSync;

  constructor(db: DatabaseSync, tx: TransactionRunner, logger: Logger) {
    this.#db = db;
    this.#tx = tx;
    this.#logger = logger;
    this.#list = db.prepare(`SELECT ${COLUMNS} FROM folders ORDER BY position ASC, created_at ASC, id ASC`);
    this.#get = db.prepare(`SELECT ${COLUMNS} FROM folders WHERE id = ?`);
    this.#upsert = db.prepare(
      `INSERT INTO folders (${COLUMNS}) VALUES (:id, :name, :color, :collapsed, :position, :created_at)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, collapsed = excluded.collapsed,
         position = excluded.position, created_at = excluded.created_at`
    );
    this.#delete = db.prepare('DELETE FROM folders WHERE id = ?');
    this.#unassignAll = db.prepare('UPDATE downloads SET folder_id = NULL WHERE folder_id = ?');
    this.#maxPosition = db.prepare('SELECT MAX(position) AS max_position FROM folders');
  }

  list(): FolderDto[] {
    return mapRows(this.#list.all(), rowToFolder, this.#logger, 'folders');
  }

  get(id: string): FolderDto | null {
    return mapRow(this.#get.get(id), rowToFolder, this.#logger, 'folders');
  }

  save(folder: FolderDto): void {
    this.#upsert.run({
      id: folder.id,
      name: folder.name,
      color: folder.color,
      collapsed: folder.collapsed ? 1 : 0,
      position: folder.position,
      created_at: folder.createdAt
    });
  }

  delete(id: string): void {
    this.#tx.transaction(() => {
      this.#unassignAll.run(id);
      this.#delete.run(id);
    });
  }

  assign(conversationIds: readonly string[], folderId: string | null): number {
    if (conversationIds.length === 0) return 0;
    // An unknown folder assigns nothing instead of failing on the foreign key.
    if (folderId !== null && this.#get.get(folderId) === undefined) return 0;
    return this.#tx.transaction(() => {
      let changed = 0;
      for (const group of chunk([...new Set(conversationIds)])) {
        const statement = this.#db.prepare(
          `UPDATE downloads SET folder_id = ?
           WHERE id IN (${placeholders(group.length)}) AND folder_id IS NOT ?`
        );
        changed += Number(statement.run(folderId, ...group, folderId).changes);
      }
      return changed;
    });
  }

  unassignAll(folderId: string): void {
    this.#unassignAll.run(folderId);
  }

  nextPosition(): number {
    const max = this.#maxPosition.get()?.['max_position'];
    return typeof max === 'number' ? max + 1 : 0;
  }
}
