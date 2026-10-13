/** `conversations.moveToFolder` — assigns conversations to a sidebar folder (`null` = unfiled). */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { FolderRepository } from '../ports/persistence.ts';
import type { EventSink } from '../ports/system.ts';

export class MoveToFolderService {
  readonly #folders: Pick<FolderRepository, 'get' | 'assign'>;
  readonly #events: EventSink;

  constructor(folders: Pick<FolderRepository, 'get' | 'assign'>, events: EventSink) {
    this.#folders = folders;
    this.#events = events;
  }

  moveToFolder(
    payload: CommandPayload<'conversations.moveToFolder'>
  ): Result<CommandResult<'conversations.moveToFolder'>, AppErrorData> {
    const { folderId } = payload;
    if (folderId !== null && !this.#folders.get(folderId)) {
      return err(appError(ErrorCode.FOLDER_NOT_FOUND, { folderId }));
    }
    const moved = this.#folders.assign([...new Set(payload.conversationIds)], folderId);
    if (moved > 0) this.#events.publish({ type: 'folders.changed' });
    return ok({ moved });
  }
}
