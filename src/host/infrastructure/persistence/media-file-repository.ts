/** SQLite `MediaFileRepository`. */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { MediaFileDto, Page } from '../../../shared/contracts/dto.ts';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { MediaFileRepository, NewMediaFile, TransactionRunner } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import { clampLimit, decodeFileCursor, encodeFileCursor } from './cursor.ts';
import { directoryLikePatterns, matchDirectory, trimTrailingSeparators } from './path-prefix.ts';
import { chunk, mapRow, mapRows, placeholders } from './row-mapping.ts';
import { MediaFileRowSchema } from './row-schemas.ts';

const TABLE = 'media_files';
const COLUMNS = 'id, conversation_id, path, name, media_type, extension, size_bytes, created_at';

export function rowToMediaFile(row: unknown): Result<MediaFileDto, string> {
  const parsed = MediaFileRowSchema.parse(row);
  if (!parsed.ok) return err(`${parsed.error.path}: ${parsed.error.reason}`);
  const r = parsed.value;
  return ok({
    id: r.id,
    conversationId: r.conversation_id,
    path: r.path,
    name: r.name,
    mediaType: r.media_type,
    extension: r.extension,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at
  });
}

export interface MediaFileRepositoryOptions {
  readonly db: DatabaseSync;
  readonly tx: TransactionRunner;
  readonly logger: Logger;
  /** On Windows, path lookups (delete, library enrichment) ignore case. */
  readonly platform: HostPlatform;
}

export class SqliteMediaFileRepository implements MediaFileRepository {
  readonly #db: DatabaseSync;
  readonly #tx: TransactionRunner;
  readonly #logger: Logger;
  readonly #caseInsensitivePaths: boolean;
  readonly #insert: StatementSync;
  readonly #firstPage: StatementSync;
  readonly #nextPage: StatementSync;
  readonly #count: StatementSync;
  readonly #paths: StatementSync;
  readonly #deleteByConversation: StatementSync;
  readonly #deleteById: StatementSync;
  readonly #renameCandidates: StatementSync;
  readonly #updatePath: StatementSync;

  constructor(options: MediaFileRepositoryOptions) {
    const { db } = options;
    this.#db = db;
    this.#tx = options.tx;
    this.#logger = options.logger;
    this.#caseInsensitivePaths = options.platform === 'win32';
    this.#insert = db.prepare(
      `INSERT INTO media_files (conversation_id, path, name, media_type, extension, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    );
    this.#firstPage = db.prepare(
      `SELECT ${COLUMNS} FROM media_files WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`
    );
    this.#nextPage = db.prepare(
      `SELECT ${COLUMNS} FROM media_files WHERE conversation_id = ? AND (created_at, id) > (?, ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`
    );
    this.#count = db.prepare('SELECT COUNT(*) AS n FROM media_files WHERE conversation_id = ?');
    this.#paths = db.prepare('SELECT path FROM media_files WHERE conversation_id = ? ORDER BY created_at ASC, id ASC');
    this.#deleteByConversation = db.prepare('DELETE FROM media_files WHERE conversation_id = ?');
    this.#deleteById = db.prepare('DELETE FROM media_files WHERE id = ?');
    this.#renameCandidates = db.prepare(
      `SELECT id, path FROM media_files WHERE path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'`
    );
    // OR REPLACE: if the target path is already recorded for the same conversation, keep one row.
    this.#updatePath = db.prepare('UPDATE OR REPLACE media_files SET path = ? WHERE id = ?');
  }

  add(file: NewMediaFile): MediaFileDto | null {
    const result = this.#insert.run(
      file.conversationId,
      file.path,
      file.name,
      file.mediaType,
      file.extension,
      file.sizeBytes,
      file.createdAt
    );
    if (Number(result.changes) === 0) return null;
    return { id: Number(result.lastInsertRowid), ...file };
  }

  listByConversation(conversationId: string, limit: number, cursor: string | null): Page<MediaFileDto> {
    const size = clampLimit(limit);
    let rows: unknown[];
    if (cursor === null) {
      rows = this.#firstPage.all(conversationId, size + 1);
    } else {
      const key = decodeFileCursor(cursor);
      if (!key) {
        this.#logger.warn('invalid files cursor', { conversationId });
        return { items: [], nextCursor: null };
      }
      rows = this.#nextPage.all(conversationId, key.createdAt, key.id, size + 1);
    }
    const pageRows = rows.slice(0, size);
    const items = mapRows(pageRows, rowToMediaFile, this.#logger, TABLE);
    // The cursor comes from the last raw row so a skipped corrupted row cannot stall paging.
    const last = rows.length > size ? fileSortKey(pageRows.at(-1)) : null;
    return { items, nextCursor: last ? encodeFileCursor(last) : null };
  }

  countByConversation(conversationId: string): number {
    const n = this.#count.get(conversationId)?.['n'];
    return typeof n === 'number' ? n : 0;
  }

  pathsByConversation(conversationId: string): string[] {
    const out: string[] = [];
    for (const row of this.#paths.all(conversationId)) {
      if (typeof row['path'] === 'string') out.push(row['path']);
    }
    return out;
  }

  deleteByConversation(conversationId: string): number {
    return Number(this.#deleteByConversation.run(conversationId).changes);
  }

  deleteByPaths(paths: readonly string[]): number {
    if (paths.length === 0) return 0;
    return this.#tx.transaction(() => {
      let deleted = 0;
      for (const row of this.#rowsForPaths(paths)) {
        deleted += Number(this.#deleteById.run(row.id).changes);
      }
      return deleted;
    });
  }

  renameDirectory(oldDir: string, newDir: string, caseInsensitive: boolean): number {
    const from = trimTrailingSeparators(oldDir);
    const to = trimTrailingSeparators(newDir);
    if (from === '' || to === '') return 0;
    const [exact, slash, backslash] = directoryLikePatterns(from);
    return this.#tx.transaction(() => {
      let changed = 0;
      for (const row of this.#renameCandidates.all(exact ?? '', slash ?? '', backslash ?? '')) {
        const id = row['id'];
        const path = row['path'];
        if (typeof id !== 'number' || typeof path !== 'string') continue;
        const rest = matchDirectory(path, from, caseInsensitive);
        if (rest === null) continue;
        const next = to + rest;
        if (next === path) continue;
        this.#updatePath.run(next, id);
        changed += 1;
      }
      return changed;
    });
  }

  conversationIdsForPaths(paths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;
    const wanted = new Map<string, string[]>();
    for (const path of paths) {
      const key = this.#pathKey(path);
      const list = wanted.get(key);
      if (list) list.push(path);
      else wanted.set(key, [path]);
    }
    // Newest producer wins when several conversations recorded the same path.
    const rows = this.#rowsForPaths(paths).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    for (const row of rows) {
      if (row.conversationId === null) continue;
      for (const input of wanted.get(this.#pathKey(row.path)) ?? []) {
        if (!out.has(input)) out.set(input, row.conversationId);
      }
    }
    return out;
  }

  pathsReferencedElsewhere(paths: readonly string[], conversationId: string): string[] {
    if (paths.length === 0) return [];
    const referenced = new Set<string>();
    for (const row of this.#rowsForPaths(paths)) {
      if (row.conversationId !== null && row.conversationId !== conversationId) referenced.add(this.#pathKey(row.path));
    }
    return paths.filter((path) => referenced.has(this.#pathKey(path)));
  }

  #pathKey(path: string): string {
    return this.#caseInsensitivePaths ? path.toLowerCase() : path;
  }

  /** Rows whose path equals one of `paths` (case-insensitively on Windows). */
  #rowsForPaths(paths: readonly string[]): Array<{
    id: number;
    path: string;
    conversationId: string | null;
    createdAt: number;
  }> {
    const keys = new Set(paths.map((path) => this.#pathKey(path)));
    const out: Array<{ id: number; path: string; conversationId: string | null; createdAt: number }> = [];
    const seen = new Set<number>();
    for (const group of chunk([...new Set(paths)])) {
      // NOCASE uses the path index; the exact comparison happens below.
      const statement = this.#db.prepare(
        `SELECT id, path, conversation_id, created_at FROM media_files
         WHERE path COLLATE NOCASE IN (${placeholders(group.length)})`
      );
      for (const row of statement.all(...group)) {
        const mapped = mapRow(row, rowToPathRow, this.#logger, TABLE);
        if (!mapped || seen.has(mapped.id) || !keys.has(this.#pathKey(mapped.path))) continue;
        seen.add(mapped.id);
        out.push(mapped);
      }
    }
    return out;
  }
}

function fileSortKey(row: unknown): { createdAt: number; id: number } | null {
  if (typeof row !== 'object' || row === null) return null;
  const { created_at: createdAt, id } = row as { created_at?: unknown; id?: unknown };
  return typeof createdAt === 'number' && typeof id === 'number' ? { createdAt, id } : null;
}

function rowToPathRow(
  row: unknown
): Result<{ id: number; path: string; conversationId: string | null; createdAt: number }, string> {
  const r = row as Record<string, unknown>;
  const { id, path, conversation_id: conversationId, created_at: createdAt } = r;
  if (typeof id !== 'number' || typeof path !== 'string' || typeof createdAt !== 'number') return err('shape');
  if (conversationId !== null && typeof conversationId !== 'string') return err('conversation_id');
  return ok({ id, path, conversationId, createdAt });
}
