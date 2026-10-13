/**
 * Reads process identity (image name + start token) from the OS, asynchronously.
 *
 * - Windows: PowerShell `Get-CimInstance Win32_Process` (batched WQL filter,
 *   timeout 8 s) → start token = normalized CreationDate, source `powershell`.
 *   `tasklist` is only a liveness/image-name fallback when PowerShell fails.
 * - Linux: `/proc/<pid>/stat` field 22 + `/proc/<pid>/comm`, source `proc`.
 * - macOS: `ps -o pid=,lstart=,comm=`, source `ps`.
 */
import { readFile, readlink } from 'node:fs/promises';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { CommandRunner } from './command-runner.ts';
import { imageNameOf, isExitedState, parseProcStat, parsePsOutput, psArgs } from './posix-process-query.ts';
import {
  type ProcessIdentityReader,
  type ProcessLookup,
  type ProcessSnapshot,
  isValidPid,
  uniquePids,
  unknownSnapshot
} from './process-snapshot.ts';
import {
  parsePowershellProcesses,
  parseTasklistCsv,
  powershellQueryArgs,
  tasklistArgs,
  windowsSystemPaths,
  type WindowsSystemPaths
} from './windows-process-query.ts';

/** PIDs per batched OS query (keeps command lines short). */
const QUERY_BATCH = 64;
const POWERSHELL_TIMEOUT_MS = 8_000;
const TASKLIST_TIMEOUT_MS = 5_000;
const PS_TIMEOUT_MS = 5_000;

export interface OsProcessIdentityReaderOptions {
  readonly platform: HostPlatform;
  readonly runner: CommandRunner;
  /** Windows `%SystemRoot%` (defaults to the environment, then `C:\Windows`). */
  readonly systemRoot?: string;
  /** Linux procfs mount point (tests may point it at a fake tree). */
  readonly procRoot?: string;
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ESRCH' || code === 'ENOTDIR';
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function defaultSystemRoot(): string {
  return process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
}

export class OsProcessIdentityReader implements ProcessIdentityReader {
  readonly #platform: HostPlatform;
  readonly #runner: CommandRunner;
  readonly #windows: WindowsSystemPaths;
  readonly #procRoot: string;

  constructor(options: OsProcessIdentityReaderOptions) {
    this.#platform = options.platform;
    this.#runner = options.runner;
    this.#windows = windowsSystemPaths(options.systemRoot ?? defaultSystemRoot());
    this.#procRoot = (options.procRoot ?? '/proc').replace(/\/+$/, '');
  }

  async read(pid: number): Promise<ProcessLookup> {
    if (!isValidPid(pid)) return null;
    const result = await this.readMany([pid]);
    return result.get(pid) ?? null;
  }

  async readMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessLookup>> {
    const valid = uniquePids(pids);
    const out = new Map<number, ProcessLookup>();
    for (const pid of pids) if (!isValidPid(pid)) out.set(pid, null);
    if (valid.length === 0) return out;
    const found =
      this.#platform === 'win32'
        ? await this.#readWindows(valid)
        : this.#platform === 'darwin'
          ? await this.#readDarwin(valid)
          : await this.#readLinux(valid);
    for (const [pid, lookup] of found) out.set(pid, lookup);
    return out;
  }

  // ---------------------------------------------------------------- Windows

  async #readWindows(pids: readonly number[]): Promise<Map<number, ProcessLookup>> {
    const out = new Map<number, ProcessLookup>();
    const failed: number[] = [];
    for (const group of chunk(pids, QUERY_BATCH)) {
      const result = await this.#runner.run(this.#windows.powershell, powershellQueryArgs(group), {
        timeoutMs: POWERSHELL_TIMEOUT_MS
      });
      const rows = result.code === 0 ? parsePowershellProcesses(result.stdout) : null;
      if (!rows) {
        failed.push(...group);
        continue;
      }
      const byPid = new Map(rows.map((row) => [row.pid, row] as const));
      for (const pid of group) out.set(pid, byPid.get(pid) ?? null);
    }
    if (failed.length > 0) {
      for (const [pid, lookup] of await this.#readTasklist(failed)) out.set(pid, lookup);
    }
    return out;
  }

  /** Fallback: image names only (no start token), one call for all PIDs. */
  async #readTasklist(pids: readonly number[]): Promise<Map<number, ProcessLookup>> {
    const single = pids.length === 1 ? (pids[0] ?? null) : null;
    const result = await this.#runner.run(this.#windows.tasklist, tasklistArgs(single), {
      timeoutMs: TASKLIST_TIMEOUT_MS
    });
    const out = new Map<number, ProcessLookup>();
    if (result.code !== 0) {
      for (const pid of pids) out.set(pid, unknownSnapshot(pid));
      return out;
    }
    const images = parseTasklistCsv(result.stdout);
    for (const pid of pids) {
      const image = images.get(pid);
      out.set(pid, image === undefined ? null : { ...unknownSnapshot(pid), imageName: image });
    }
    return out;
  }

  // ------------------------------------------------------------------ macOS

  async #readDarwin(pids: readonly number[]): Promise<Map<number, ProcessLookup>> {
    const out = new Map<number, ProcessLookup>();
    for (const group of chunk(pids, QUERY_BATCH)) {
      // LC_ALL=C keeps `lstart` in a fixed, parseable format.
      const result = await this.#runner.run('/bin/ps', psArgs(group), {
        timeoutMs: PS_TIMEOUT_MS,
        env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
      });
      // ps exits 1 when some PIDs do not exist; anything else means the query failed.
      if (result.code !== 0 && result.code !== 1) {
        for (const pid of group) out.set(pid, unknownSnapshot(pid));
        continue;
      }
      const rows = parsePsOutput(result.stdout);
      for (const pid of group) {
        const row = rows.get(pid);
        out.set(
          pid,
          row
            ? {
                pid,
                imageName: imageNameOf(row.command),
                startToken: row.startToken,
                startTokenSource: 'ps',
                executablePath: row.command.startsWith('/') ? row.command : null
              }
            : null
        );
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ Linux

  async #readLinux(pids: readonly number[]): Promise<Map<number, ProcessLookup>> {
    const entries = await Promise.all(pids.map(async (pid) => [pid, await this.#readProc(pid)] as const));
    return new Map(entries);
  }

  async #readProc(pid: number): Promise<ProcessLookup> {
    const base = `${this.#procRoot}/${pid}`;
    let statText: string;
    try {
      statText = await readFile(`${base}/stat`, 'utf8');
    } catch (error) {
      return isMissing(error) ? null : unknownSnapshot(pid);
    }
    const stat = parseProcStat(statText);
    if (stat && isExitedState(stat.state)) return null;
    const [comm, exe] = await Promise.all([
      readFile(`${base}/comm`, 'utf8').then(
        (text) => text.trim().toLowerCase() || null,
        () => null
      ),
      readlink(`${base}/exe`).then(
        (target) => target,
        () => null
      )
    ]);
    const snapshot: ProcessSnapshot = {
      pid,
      imageName: comm,
      startToken: stat?.startTime ?? null,
      startTokenSource: stat ? 'proc' : null,
      executablePath: exe
    };
    return snapshot;
  }
}
