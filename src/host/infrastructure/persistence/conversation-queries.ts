/**
 * Read side of the history (`ConversationQueries`): summaries with per-page
 * aggregates (cover, primary media type, total bytes), details with the newest
 * 300 events (oldest first — the legacy app returned the oldest 300).
 *
 * The page is selected first (keyset over `idx_downloads_updated`) and the
 * aggregates are computed only for its rows through covering indexes, so the
 * cost is independent of the table sizes.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { v } from '../../../shared/validation/schema.ts';
import { MEDIA_TYPES } from '../../../shared/domain/media.ts';
import type {
  ConversationDetailDto,
  ConversationEventDto,
  ConversationSummaryDto,
  Page
} from '../../../shared/contracts/dto.ts';
import type { ConversationQueries, MediaFileRepository } from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';
import { clampLimit, decodeConversationCursor, encodeConversationCursor } from './cursor.ts';
import { downloadColumns, rowToDownload } from './download-row.ts';
import { EVENT_COLUMNS, rowToEvent } from './event-repository.ts';
import { mapRow, mapRows } from './row-mapping.ts';

export const DETAIL_EVENT_LIMIT = 300;

const AggregatesSchema = v.object(
  {
    cover_path: v.nullable(v.string({ max: 1_000_000, noControlChars: false })),
    primary_media_type: v.nullable(v.enum(MEDIA_TYPES)),
    total_bytes: v.number({ int: true, min: 0 })
  },
  { strict: false }
);

const AGGREGATES = `
  (SELECT f.path FROM media_files f WHERE f.conversation_id = d.id
     ORDER BY f.created_at ASC, f.id ASC LIMIT 1) AS cover_path,
  (SELECT f.media_type FROM media_files f WHERE f.conversation_id = d.id
     GROUP BY f.media_type ORDER BY COUNT(*) DESC, f.media_type ASC LIMIT 1) AS primary_media_type,
  (SELECT COALESCE(SUM(f.size_bytes), 0) FROM media_files f WHERE f.conversation_id = d.id) AS total_bytes`;

/**
 * Page query: the inner SELECT picks the page through `idx_downloads_updated`
 * (keyset `(updated_at, id) < cursor`), the aggregates run only for those rows.
 * Parameters: `[cursorUpdatedAt, cursorId,] limit`.
 */
export function conversationPageSql(withCursor: boolean): string {
  const where = withCursor ? 'WHERE (updated_at, id) < (?, ?)' : '';
  return `SELECT ${downloadColumns('d')}, ${AGGREGATES} FROM (
    SELECT * FROM downloads ${where} ORDER BY updated_at DESC, id DESC LIMIT ?
  ) AS d ORDER BY d.updated_at DESC, d.id DESC`;
}

function rowToSummary(row: unknown): Result<ConversationSummaryDto, string> {
  const record = rowToDownload(row);
  if (!record.ok) return record;
  const aggregates = AggregatesSchema.parse(row);
  if (!aggregates.ok) return err(`${aggregates.error.path}: ${aggregates.error.reason}`);
  const r = record.value;
  const a = aggregates.value;
  return ok({
    id: r.id,
    batchId: r.batchId,
    sourceUrl: r.sourceUrl,
    title: r.title,
    engine: r.engine,
    scope: r.scope,
    status: r.status,
    outcome: r.outcome,
    legacySummary: r.legacySummary,
    counters: r.counters,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    updatedAt: r.updatedAt,
    coverPath: a.cover_path,
    primaryMediaType: a.primary_media_type,
    totalBytes: a.total_bytes,
    folderId: r.folderId
  });
}

function sortKey(row: unknown): { updatedAt: number; id: string } | null {
  if (typeof row !== 'object' || row === null) return null;
  const { updated_at: updatedAt, id } = row as { updated_at?: unknown; id?: unknown };
  return typeof updatedAt === 'number' && typeof id === 'string' ? { updatedAt, id } : null;
}

export class SqliteConversationQueries implements ConversationQueries {
  readonly #logger: Logger;
  readonly #files: MediaFileRepository;
  readonly #firstPage: StatementSync;
  readonly #nextPage: StatementSync;
  readonly #get: StatementSync;
  readonly #recentEvents: StatementSync;

  constructor(db: DatabaseSync, files: MediaFileRepository, logger: Logger) {
    this.#logger = logger;
    this.#files = files;
    this.#firstPage = db.prepare(conversationPageSql(false));
    this.#nextPage = db.prepare(conversationPageSql(true));
    this.#get = db.prepare(`SELECT ${downloadColumns('d')}, ${AGGREGATES} FROM downloads AS d WHERE d.id = ?`);
    this.#recentEvents = db.prepare(
      `SELECT * FROM (
         SELECT ${EVENT_COLUMNS} FROM conversation_events WHERE conversation_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
       ) ORDER BY created_at ASC, id ASC`
    );
  }

  list(limit: number, cursor: string | null): Page<ConversationSummaryDto> {
    const size = clampLimit(limit);
    let rows: unknown[];
    if (cursor === null) {
      rows = this.#firstPage.all(size + 1);
    } else {
      const key = decodeConversationCursor(cursor);
      if (!key) {
        this.#logger.warn('invalid conversations cursor');
        return { items: [], nextCursor: null };
      }
      rows = this.#nextPage.all(key.updatedAt, key.id, size + 1);
    }
    const pageRows = rows.slice(0, size);
    const items = mapRows(pageRows, rowToSummary, this.#logger, 'downloads');
    // The cursor comes from the last raw row so a skipped corrupted row cannot stall paging.
    const last = rows.length > size ? sortKey(pageRows.at(-1)) : null;
    return { items, nextCursor: last ? encodeConversationCursor(last) : null };
  }

  get(id: string): ConversationDetailDto | null {
    const summary = mapRow(this.#get.get(id), rowToSummary, this.#logger, 'downloads');
    if (!summary) return null;
    return {
      ...summary,
      events: this.recentEvents(id, DETAIL_EVENT_LIMIT),
      filesCount: this.#files.countByConversation(id)
    };
  }

  /** The newest `limit` events, returned oldest first. */
  recentEvents(conversationId: string, limit: number): ConversationEventDto[] {
    const rows = this.#recentEvents.all(conversationId, clampLimit(limit, 10_000));
    return mapRows(rows, rowToEvent, this.#logger, 'conversation_events');
  }
}
