/**
 * Extracts zip / tar.gz / tar.xz with the operating system's archivers (no shell):
 * - Windows: `%SystemRoot%\System32\tar.exe` (bsdtar, ships with Windows 10+) —
 *   absolute path, so a GNU tar earlier on PATH (Git for Windows) is never used;
 * - macOS: `/usr/bin/tar` (bsdtar, handles zip too);
 * - Linux: `tar` for tarballs; `unzip` (fallback `bsdtar`) for zip.
 * Every archive is listed first and rejected if a member name is absolute or has
 * `..`; after extraction the tree is walked so no entry or symlink escapes.
 * Paths are passed relative to the archive directory (Windows tar may read `C:` as
 * a remote host name).
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { ArchiveKind } from '../../application/runtime/manifest.ts';
import type { ArchiveExtractor } from '../../application/runtime/ports.ts';
import type { CommandResult } from '../process/command-runner.ts';
import {
  ABORTED,
  ExecFileCancellableRunner,
  OUTPUT_TOO_LARGE,
  type CancellableCommandRunner
} from './cancellable-command.ts';
import { succeeded } from './command-result.ts';
import { findEscape, isUnsafeEntryName } from './path-containment.ts';

export interface ArchiveExtractorOptions {
  readonly platform: HostPlatform;
  readonly runner?: CancellableCommandRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

interface ArchiverCommand {
  readonly command: string;
  readonly list: (archive: string) => string[];
  readonly extract: (archive: string, dest: string) => string[];
}

const tarCommand = (command: string): ArchiverCommand => ({
  command,
  list: (archive) => ['-tf', archive],
  extract: (archive, dest) => ['-xf', archive, '-C', dest]
});

const UNZIP: ArchiverCommand = {
  command: 'unzip',
  list: (archive) => ['-Z1', archive],
  extract: (archive, dest) => ['-q', '-o', archive, '-d', dest]
};

export function archiversFor(
  platform: HostPlatform,
  kind: Exclude<ArchiveKind, 'none'>,
  env: Readonly<Record<string, string | undefined>>
): ArchiverCommand[] {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
    return [tarCommand(path.win32.join(systemRoot, 'System32', 'tar.exe'))];
  }
  if (platform === 'darwin') return [tarCommand('/usr/bin/tar')];
  return kind === 'zip' ? [UNZIP, tarCommand('bsdtar')] : [tarCommand('tar')];
}

function failure(tool: ToolId, detail: string): Result<never, AppErrorData> {
  return err({ code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool, detail: detail.slice(0, 300) } });
}

function describe(result: CommandResult): string {
  if (result.error === 'ETIMEDOUT') return 'extraction timed out';
  if (result.error === OUTPUT_TOO_LARGE) return 'archive listing too large';
  if (result.error) return result.error;
  const line = result.stderr.split(/\r?\n/).find((l) => l.trim());
  return line?.trim() ?? `exit code ${String(result.code)}`;
}

export class SystemArchiveExtractor implements ArchiveExtractor {
  readonly #platform: HostPlatform;
  readonly #runner: CancellableCommandRunner;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #timeoutMs: number;

  constructor(options: ArchiveExtractorOptions) {
    this.#platform = options.platform;
    this.#runner = options.runner ?? new ExecFileCancellableRunner();
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async extract(
    tool: ToolId,
    archivePath: string,
    destinationDir: string,
    kind: Exclude<ArchiveKind, 'none'>,
    signal: AbortSignal
  ): Promise<Result<void, AppErrorData>> {
    await mkdir(destinationDir, { recursive: true });
    const cwd = path.dirname(archivePath);
    const archive = path.basename(archivePath);
    const relativeDest = path.relative(cwd, destinationDir) || '.';
    const dest = path.isAbsolute(relativeDest) ? destinationDir : relativeDest;
    // A listing larger than the buffer fails (OUTPUT_TOO_LARGE): every member name must be inspected.
    const run = (command: string, args: string[]): Promise<CommandResult> =>
      this.#runner.run(command, args, { cwd, timeoutMs: this.#timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 });

    for (const archiver of archiversFor(this.#platform, kind, this.#env)) {
      const listing = await run(archiver.command, archiver.list(archive));
      if (listing.error === 'ENOENT') continue;
      if (listing.error === ABORTED || signal.aborted) return err({ code: ErrorCode.CANCELLED });
      if (!succeeded(listing)) return failure(tool, describe(listing));
      const unsafe = listing.stdout.split(/\r?\n/).find(isUnsafeEntryName);
      if (unsafe !== undefined) return failure(tool, `unsafe archive entry: ${unsafe}`);

      const extraction = await run(archiver.command, archiver.extract(archive, dest));
      if (extraction.error === ABORTED || signal.aborted) return err({ code: ErrorCode.CANCELLED });
      if (!succeeded(extraction)) return failure(tool, describe(extraction));
      const escape = await findEscape(destinationDir);
      if (escape !== null) {
        await rm(destinationDir, { recursive: true, force: true });
        return failure(tool, `unsafe archive entry: ${escape}`);
      }
      return ok();
    }
    return failure(tool, 'no archive tool found (tar/unzip)');
  }
}
