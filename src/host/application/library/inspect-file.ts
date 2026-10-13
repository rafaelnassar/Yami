/**
 * `files.inspect` — canonical path, existence, size, media type, preview MIME and
 * open risk of a path inside the download dir. Main uses it before opening,
 * revealing or previewing anything, so the host's sandbox decides what is
 * reachable.
 */
import type { FileInspectionDto } from '../../../shared/contracts/dto.ts';
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { baseName, mediaTypeOf, previewMimeOf } from '../../../shared/domain/media.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import { entryOpenRisk } from '../../domain/library/open-risk.ts';
import type { FileStat, FileSystemPort, PathSandbox } from '../ports/files.ts';

function describe(path: string, stat: FileStat | null): FileInspectionDto {
  const name = baseName(path).normalize('NFC');
  if (stat?.isDirectory) {
    // Never previewed; a plain folder is safe to show, but bundles (`Evil.app`) and
    // CLSID junctions would be launched by the OS, so those are blocked.
    return {
      path,
      name,
      exists: true,
      isDirectory: true,
      sizeBytes: null,
      mediaType: 'other',
      previewMime: null,
      risk: entryOpenRisk(name, true)
    };
  }
  return {
    path,
    name,
    exists: stat !== null,
    isDirectory: false,
    sizeBytes: stat?.sizeBytes ?? null,
    mediaType: mediaTypeOf(name),
    previewMime: stat ? previewMimeOf(name) : null,
    risk: entryOpenRisk(name, false)
  };
}

export class InspectFileService {
  readonly #sandbox: Pick<PathSandbox, 'resolveInside'>;
  readonly #fs: Pick<FileSystemPort, 'stat'>;

  constructor(sandbox: Pick<PathSandbox, 'resolveInside'>, fs: Pick<FileSystemPort, 'stat'>) {
    this.#sandbox = sandbox;
    this.#fs = fs;
  }

  async inspect(
    payload: CommandPayload<'files.inspect'>
  ): Promise<Result<CommandResult<'files.inspect'>, AppErrorData>> {
    const resolved = await this.#sandbox.resolveInside(payload.path, { mustExist: false });
    if (!resolved.ok) return resolved;
    return ok(describe(resolved.value, await this.#fs.stat(resolved.value)));
  }
}
