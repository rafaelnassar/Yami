/**
 * Reads the legacy `~/.yami/yami.sqlite` (schema v1, spec 02 §4.2).
 *
 * The legacy files are never touched: the database (and its WAL, which may hold
 * the newest rows after a crash) is copied into a private work directory and
 * the copy is opened read-only — opening the original, even read-only, would
 * create a `-shm` file next to it.
 */
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { v, type Infer, type Schema } from '../../../shared/validation/schema.ts';
import { DOWNLOAD_STATUSES } from '../../../shared/contracts/dto.ts';
import { DOWNLOAD_SCOPES, ENGINES } from '../../../shared/domain/engine.ts';

export const LEGACY_DATABASE_FILE = 'yami.sqlite';

const text = v.string({ max: 1_000_000, noControlChars: false });
const int = v.number({ int: true });
const count = v.number({ int: true, min: 0 });

const BatchRowSchema = v.object(
  {
    id: v.id(),
    engine: v.enum(ENGINES),
    scope: v.enum(DOWNLOAD_SCOPES),
    status: v.enum(DOWNLOAD_STATUSES),
    total_items: count,
    created_at: int,
    completed_at: v.nullable(int)
  },
  { strict: false }
);

const ConversationRowSchema = v.object(
  {
    // Rows whose id is not a protocol id could never be addressed by the UI.
    id: v.id(),
    batch_id: v.nullable(text),
    source_url: v.string({ min: 1, max: 4096, noControlChars: false }),
    title: text,
    engine: v.enum(ENGINES),
    status: v.enum(DOWNLOAD_STATUSES),
    summary: text,
    files_downloaded: count,
    files_skipped: count,
    errors_count: count,
    created_at: int,
    started_at: v.nullable(int),
    completed_at: v.nullable(int),
    updated_at: int
  },
  { strict: false }
);

const FileRowSchema = v.object(
  {
    path: v.string({ min: 1, max: 32_767, noControlChars: false }),
    name: text,
    size_bytes: v.nullable(count),
    created_at: int
  },
  { strict: false }
);

const EventRowSchema = v.object({ event_type: text, level: text, message: text, created_at: int }, { strict: false });

export type LegacyBatchRow = Infer<typeof BatchRowSchema>;
export type LegacyConversationRow = Infer<typeof ConversationRowSchema>;
export type LegacyFileRow = Infer<typeof FileRowSchema>;
export type LegacyEventRow = Infer<typeof EventRowSchema>;

export class LegacyDatabaseReader {
  readonly #db: DatabaseSync;
  readonly #workDir: string;
  #invalidRows = 0;
  #filesQuery: StatementSync | null | undefined;
  #eventsQuery: StatementSync | null | undefined;

  private constructor(db: DatabaseSync, workDir: string) {
    this.#db = db;
    this.#workDir = workDir;
  }

  /** Returns `null` when the legacy database does not exist. */
  static async open(legacyDir: string, workRoot: string): Promise<LegacyDatabaseReader | null> {
    const source = path.join(legacyDir, LEGACY_DATABASE_FILE);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) return null;
    await mkdir(workRoot, { recursive: true });
    const workDir = await mkdtemp(path.join(workRoot, 'yami-legacy-'));
    let db: DatabaseSync | null = null;
    try {
      const copy = path.join(workDir, LEGACY_DATABASE_FILE);
      await copyFile(source, copy);
      await copyFile(`${source}-wal`, `${copy}-wal`).catch(() => undefined);
      db = new DatabaseSync(copy, { readOnly: true });
      // Fail here (not in the middle of the import) when the file is not a usable database.
      db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
      return new LegacyDatabaseReader(db, workDir);
    } catch (error) {
      db?.close();
      await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Rows that failed validation so far (skipped). */
  get invalidRows(): number {
    return this.#invalidRows;
  }

  batches(): LegacyBatchRow[] {
    if (!this.#hasTable('download_batches')) return [];
    return this.#validRows(
      this.#db.prepare('SELECT * FROM download_batches ORDER BY created_at ASC, id ASC').all(),
      BatchRowSchema
    );
  }

  conversations(): LegacyConversationRow[] {
    if (!this.#hasTable('download_conversations')) return [];
    return this.#validRows(
      this.#db.prepare('SELECT * FROM download_conversations ORDER BY created_at ASC, id ASC').all(),
      ConversationRowSchema
    );
  }

  files(conversationId: string): LegacyFileRow[] {
    if (this.#filesQuery === undefined) this.#filesQuery = this.#perConversation('download_files');
    return this.#validRows(this.#filesQuery?.all(conversationId) ?? [], FileRowSchema);
  }

  events(conversationId: string): LegacyEventRow[] {
    if (this.#eventsQuery === undefined) this.#eventsQuery = this.#perConversation('download_events');
    return this.#validRows(this.#eventsQuery?.all(conversationId) ?? [], EventRowSchema);
  }

  async close(): Promise<void> {
    try {
      this.#db.close();
    } finally {
      await rm(this.#workDir, { recursive: true, force: true });
    }
  }

  /** Prepared once per table; `null` when the (optional) table is missing. */
  #perConversation(table: 'download_files' | 'download_events'): StatementSync | null {
    if (!this.#hasTable(table)) return null;
    return this.#db.prepare(`SELECT * FROM ${table} WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`);
  }

  #hasTable(name: string): boolean {
    return this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  #validRows<T>(rows: readonly unknown[], schema: Schema<T>): T[] {
    const out: T[] = [];
    for (const row of rows) {
      const parsed = schema.parse(row);
      if (parsed.ok) out.push(parsed.value);
      else this.#invalidRows += 1;
    }
    return out;
  }
}
