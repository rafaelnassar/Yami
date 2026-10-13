/** Read side of conversations: `conversations.list`, `conversations.get`, `conversations.files`. */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { ConversationQueries, MediaFileRepository } from '../ports/persistence.ts';

export const DEFAULT_CONVERSATION_PAGE_SIZE = 200;
export const DEFAULT_FILES_PAGE_SIZE = 200;

export class ConversationQueryService {
  readonly #queries: Pick<ConversationQueries, 'list' | 'get'>;
  readonly #files: Pick<MediaFileRepository, 'listByConversation'>;

  constructor(
    queries: Pick<ConversationQueries, 'list' | 'get'>,
    files: Pick<MediaFileRepository, 'listByConversation'>
  ) {
    this.#queries = queries;
    this.#files = files;
  }

  list(payload: CommandPayload<'conversations.list'>): Result<CommandResult<'conversations.list'>, AppErrorData> {
    return ok(this.#queries.list(payload.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE, payload.cursor ?? null));
  }

  get(payload: CommandPayload<'conversations.get'>): Result<CommandResult<'conversations.get'>, AppErrorData> {
    const conversation = this.#queries.get(payload.conversationId);
    if (!conversation) {
      return err(appError(ErrorCode.CONVERSATION_NOT_FOUND, { conversationId: payload.conversationId }));
    }
    return ok({ conversation });
  }

  files(payload: CommandPayload<'conversations.files'>): Result<CommandResult<'conversations.files'>, AppErrorData> {
    return ok(
      this.#files.listByConversation(
        payload.conversationId,
        payload.limit ?? DEFAULT_FILES_PAGE_SIZE,
        payload.cursor ?? null
      )
    );
  }
}
