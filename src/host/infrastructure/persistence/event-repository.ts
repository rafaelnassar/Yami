/** SQLite `ConversationEventRepository` + event row mapping (shared with the queries). */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { ConversationEventDto } from '../../../shared/contracts/dto.ts';
import type { ConversationEventRepository, NewConversationEvent } from '../../application/ports/persistence.ts';
import { EventRowSchema, ParamsSchema, parseJsonColumn } from './row-schemas.ts';

export const EVENT_COLUMNS = 'id, conversation_id, type, level, code, params, legacy_message, created_at';

export function rowToEvent(row: unknown): Result<ConversationEventDto, string> {
  const parsed = EventRowSchema.parse(row);
  if (!parsed.ok) return err(`${parsed.error.path}: ${parsed.error.reason}`);
  const r = parsed.value;
  const params = parseJsonColumn(r.params, ParamsSchema);
  if (!params.ok) return err(`params: ${params.error}`);
  return ok({
    id: r.id,
    conversationId: r.conversation_id,
    type: r.type,
    level: r.level,
    code: r.code,
    params: params.value,
    legacyMessage: r.legacy_message,
    createdAt: r.created_at
  });
}

/** Event with legacy free text (only written by the legacy importer). */
export interface LegacyConversationEvent extends NewConversationEvent {
  readonly legacyMessage: string | null;
}

export class SqliteConversationEventRepository implements ConversationEventRepository {
  readonly #insert: StatementSync;
  readonly #deleteByConversation: StatementSync;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      `INSERT INTO conversation_events (conversation_id, type, level, code, params, legacy_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.#deleteByConversation = db.prepare('DELETE FROM conversation_events WHERE conversation_id = ?');
  }

  append(event: NewConversationEvent): void {
    this.#write({ ...event, legacyMessage: null });
  }

  /** Infrastructure-only extension used by the legacy importer. */
  appendLegacy(event: LegacyConversationEvent): void {
    this.#write(event);
  }

  deleteByConversation(conversationId: string): void {
    this.#deleteByConversation.run(conversationId);
  }

  #write(event: LegacyConversationEvent): void {
    this.#insert.run(
      event.conversationId,
      event.type,
      event.level,
      event.code,
      JSON.stringify(event.params),
      event.legacyMessage,
      event.createdAt
    );
  }
}
