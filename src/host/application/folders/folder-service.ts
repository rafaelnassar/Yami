/**
 * Sidebar folders (`folders.list|create|update|delete`). Folders only group
 * conversations; deleting one unassigns its conversations and never deletes them.
 */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { newId } from '../../../shared/kernel/ids.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { applyFolderPatch, createFolder } from '../../domain/library/folder.ts';
import type { FolderRepository, TransactionRunner } from '../ports/persistence.ts';
import type { EventSink } from '../ports/system.ts';

export type IdGenerator = () => string;

export const newFolderId: IdGenerator = () => newId('fld-');

export interface FolderServiceDeps {
  readonly folders: FolderRepository;
  readonly tx: TransactionRunner;
  readonly events: EventSink;
  readonly clock: Clock;
  readonly newId?: IdGenerator;
}

export class FolderService {
  readonly #folders: FolderRepository;
  readonly #tx: TransactionRunner;
  readonly #events: EventSink;
  readonly #clock: Clock;
  readonly #newId: IdGenerator;

  constructor(deps: FolderServiceDeps) {
    this.#folders = deps.folders;
    this.#tx = deps.tx;
    this.#events = deps.events;
    this.#clock = deps.clock;
    this.#newId = deps.newId ?? newFolderId;
  }

  list(): Result<CommandResult<'folders.list'>, AppErrorData> {
    const folders = [...this.#folders.list()].sort(
      (a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    );
    return ok({ folders });
  }

  create(payload: CommandPayload<'folders.create'>): Result<CommandResult<'folders.create'>, AppErrorData> {
    const folder = this.#tx.transaction(() => {
      const created = createFolder({
        id: this.#newId(),
        name: payload.name,
        color: payload.color,
        position: this.#folders.nextPosition(),
        createdAt: this.#clock.now()
      });
      if (created.ok) this.#folders.save(created.value);
      return created;
    });
    if (!folder.ok) return folder;
    this.#events.publish({ type: 'folders.changed' });
    return ok({ folder: folder.value });
  }

  update(payload: CommandPayload<'folders.update'>): Result<CommandResult<'folders.update'>, AppErrorData> {
    const { folderId, ...patch } = payload;
    const current = this.#folders.get(folderId);
    if (!current) return err(appError(ErrorCode.FOLDER_NOT_FOUND, { folderId }));
    const next = applyFolderPatch(current, patch);
    if (!next.ok) return next;
    this.#folders.save(next.value);
    this.#events.publish({ type: 'folders.changed' });
    return ok({ folder: next.value });
  }

  delete(payload: CommandPayload<'folders.delete'>): Result<CommandResult<'folders.delete'>, AppErrorData> {
    const { folderId } = payload;
    if (!this.#folders.get(folderId)) return err(appError(ErrorCode.FOLDER_NOT_FOUND, { folderId }));
    this.#tx.transaction(() => {
      this.#folders.unassignAll(folderId);
      this.#folders.delete(folderId);
    });
    this.#events.publish({ type: 'folders.changed' });
    return ok({ folderId });
  }
}
