/**
 * `conversations.delete` — stops and forgets the download, removes every row of
 * the conversation in one transaction, then (optionally) deletes its files from
 * disk (sandboxed).
 *
 * Differences from the legacy handler (on purpose):
 * - the downloads core decides whether something is running (the legacy code
 *   trusted a lagging DB status and could orphan a live process);
 * - rows are removed only after the engine is stopped, and nothing is removed
 *   when stopping fails;
 * - rows are removed right after the core forgot the download, *before* the
 *   (slow) disk deletion: a concurrent resume/restart can no longer find the
 *   record and relaunch it, and a crash mid-deletion cannot leave an orphan
 *   `running` row whose log is already gone (worst case: some files stay on
 *   disk and show up in the library as unowned files);
 * - a file that another conversation also lists (a re-download of the same
 *   file) is kept on disk and in that conversation, and counted as kept — the
 *   legacy handler deleted it from under the other conversation;
 * - rows of other conversations that still point to a file deleted here (a
 *   different spelling of the path, or recorded while the deletion ran) are
 *   removed too, so the library never lists a file that no longer exists.
 */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadsFacade } from '../downloads/downloads-facade.ts';
import type { RemovalOutcome, SandboxedFileRemover } from '../library/sandboxed-file-remover.ts';
import type { LibraryScanner } from '../ports/files.ts';
import type {
  ConversationEventRepository,
  DownloadRepository,
  MediaFileRepository,
  TransactionRunner
} from '../ports/persistence.ts';
import type { EventSink } from '../ports/system.ts';

export interface DeleteConversationDeps {
  readonly downloads: Pick<DownloadsFacade, 'forget'>;
  readonly records: Pick<DownloadRepository, 'get' | 'delete'>;
  readonly files: Pick<
    MediaFileRepository,
    'pathsByConversation' | 'deleteByConversation' | 'deleteByPaths' | 'pathsReferencedElsewhere'
  >;
  readonly events: Pick<ConversationEventRepository, 'deleteByConversation'>;
  readonly tx: TransactionRunner;
  readonly remover: Pick<SandboxedFileRemover, 'remove'>;
  readonly scanner: Pick<LibraryScanner, 'invalidate'>;
  readonly sink: EventSink;
}

type DeleteResult = CommandResult<'conversations.delete'>;

interface DiskOutcome {
  readonly deleted: number;
  readonly failed: number;
  /** Stored and canonical forms of every path removed from disk. */
  readonly removedPaths: readonly string[];
}

const NOTHING_ON_DISK: DiskOutcome = { deleted: 0, failed: 0, removedPaths: [] };

export class DeleteConversationService {
  readonly #deps: DeleteConversationDeps;

  constructor(deps: DeleteConversationDeps) {
    this.#deps = deps;
  }

  async delete(payload: CommandPayload<'conversations.delete'>): Promise<Result<DeleteResult, AppErrorData>> {
    const { conversationId, deleteFiles } = payload;
    const { downloads, records, files, events, tx, scanner, sink } = this.#deps;

    const forgotten = await downloads.forget(conversationId);
    if (!forgotten.ok && forgotten.error.code !== ErrorCode.CONVERSATION_NOT_FOUND) return forgotten;

    // Idempotent: deleting twice (double click, two windows) is not an error.
    if (!records.get(conversationId)) return ok({ conversationId, filesDeleted: 0, filesFailed: 0, filesKept: 0 });

    // Read the paths after `forget` (a stopping engine may still record a file) and
    // drop the rows synchronously, with no await between forget's completion and here.
    const storedPaths = deleteFiles ? files.pathsByConversation(conversationId) : [];
    tx.transaction(() => {
      files.deleteByConversation(conversationId);
      events.deleteByConversation(conversationId);
      records.delete(conversationId);
    });

    // Before touching the disk: files other conversations still list (re-downloads) are theirs too.
    const shared = new Set(storedPaths.length > 0 ? files.pathsReferencedElsewhere(storedPaths, conversationId) : []);
    const owned = storedPaths.filter((path) => !shared.has(path));
    const disk = owned.length > 0 ? await this.#deleteFromDisk(owned) : NOTHING_ON_DISK;
    if (disk.removedPaths.length > 0) files.deleteByPaths(disk.removedPaths);

    if (disk.deleted > 0) scanner.invalidate();
    sink.publish({ type: 'conversation.changed', conversationId, reason: 'deleted' });
    return ok({ conversationId, filesDeleted: disk.deleted, filesFailed: disk.failed, filesKept: shared.size });
  }

  async #deleteFromDisk(paths: readonly string[]): Promise<DiskOutcome> {
    let deleted = 0;
    let failed = 0;
    const removedPaths = new Set<string>();
    for (const path of new Set(paths)) {
      const outcome = await this.#removeOne(path);
      if (outcome.kind === 'failed') {
        failed += 1;
      } else if (outcome.kind === 'deleted') {
        deleted += 1;
        removedPaths.add(path);
        removedPaths.add(outcome.resolvedPath);
      }
    }
    return { deleted, failed, removedPaths: [...removedPaths] };
  }

  /**
   * The rows are already gone, so an unexpected I/O exception must not abort the
   * command (the UI would keep showing a deleted conversation): count it as failed.
   */
  async #removeOne(path: string): Promise<RemovalOutcome> {
    try {
      return await this.#deps.remover.remove(path);
    } catch {
      return { kind: 'failed', error: appError(ErrorCode.FILE_OPERATION_FAILED) };
    }
  }
}
