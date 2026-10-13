/**
 * `files.delete` — deletes many library files in one request (the legacy
 * renderer sent one request per file). Each path is sandboxed independently and
 * reported in `deleted` or `failed`; a file that is already gone counts as
 * deleted (the goal state is reached) and its rows are cleaned up too.
 *
 * Rows are removed by both the given path and its canonical form, so files
 * stored under an engine-printed path are found even when the download dir
 * contains a symlink (legacy removed rows by realpath only).
 */
import type { CommandPayload, CommandResult, DeleteFilesResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { LibraryScanner } from '../ports/files.ts';
import type { MediaFileRepository } from '../ports/persistence.ts';
import type { EventSink } from '../ports/system.ts';
import type { SandboxedFileRemover } from './sandboxed-file-remover.ts';

export interface DeleteFilesDeps {
  readonly remover: Pick<SandboxedFileRemover, 'remove'>;
  readonly files: Pick<MediaFileRepository, 'deleteByPaths' | 'conversationIdsForPaths'>;
  readonly scanner: Pick<LibraryScanner, 'invalidate'>;
  readonly events: EventSink;
}

type Failure = DeleteFilesResult['failed'][number];

export class DeleteFilesService {
  readonly #deps: DeleteFilesDeps;

  constructor(deps: DeleteFilesDeps) {
    this.#deps = deps;
  }

  async delete(payload: CommandPayload<'files.delete'>): Promise<Result<CommandResult<'files.delete'>, AppErrorData>> {
    const { remover, files, scanner, events } = this.#deps;
    const paths = [...new Set(payload.paths)];
    // Read owners first: the rows are gone after the delete.
    const owners = files.conversationIdsForPaths(paths);

    const deleted: string[] = [];
    const failed: Failure[] = [];
    const rowPaths = new Set<string>();
    for (const path of paths) {
      const outcome = await remover.remove(path);
      if (outcome.kind === 'failed') {
        failed.push({ path, error: outcome.error });
        continue;
      }
      deleted.push(path);
      rowPaths.add(path);
      if (outcome.resolvedPath) rowPaths.add(outcome.resolvedPath);
    }

    if (rowPaths.size > 0) files.deleteByPaths([...rowPaths]);
    if (deleted.length > 0) {
      scanner.invalidate();
      const touched = new Set(deleted.flatMap((path) => owners.get(path) ?? []));
      for (const conversationId of touched) {
        events.publish({ type: 'conversation.changed', conversationId, reason: 'updated' });
      }
    }
    return ok({ deleted, failed });
  }
}
