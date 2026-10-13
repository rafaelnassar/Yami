/**
 * Decides whether a system directory (PATH entry or well-known install location)
 * may be probed. Probing runs `<dir>/<tool> --version` automatically at startup,
 * so a directory another local user can write to would hand them code execution
 * as the current user (e.g. a folder created under `C:\` and added to the machine
 * PATH is writable by every authenticated user).
 *
 * - Windows: ACLs are not inspected. A directory is trusted only when it lies
 *   under a root that is admin-protected (`%SystemRoot%`, `%ProgramFiles%`,
 *   `%ProgramFiles(x86)%`, `%ProgramW6432%`, `%ProgramData%\chocolatey\bin`) or
 *   private to this user (`%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`). Roots
 *   come from the injected environment and are compared case-insensitively.
 * - POSIX: the directory must exist, must not be world-writable and must be owned
 *   by root or by the current user.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { HostPlatform } from '../../application/ports/engines.ts';
import { envValue } from './tool-locations.ts';

export type UntrustedReason = 'outside-trusted-roots' | 'world-writable' | 'foreign-owner' | 'missing';

export interface DirectoryStats {
  readonly mode: number;
  readonly uid: number;
}

export interface DirectoryTrustOptions {
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /** Current user id on POSIX (`process.getuid()`); `null` trusts root-owned directories only. */
  readonly uid: number | null;
  /** `stat` that follows symlinks; `null` when missing or not a directory. */
  readonly statDir?: (directory: string) => Promise<DirectoryStats | null>;
}

const WORLD_WRITABLE = 0o002;

async function defaultStatDir(directory: string): Promise<DirectoryStats | null> {
  const stats = await stat(directory).catch(() => null);
  return stats !== null && stats.isDirectory() ? { mode: stats.mode, uid: stats.uid } : null;
}

/** Lower-case, normalized, without trailing separators (so `C:\A\` equals `c:\a`). */
function windowsKey(directory: string): string {
  return path.win32.normalize(directory).replace(/\\+$/, '').toLowerCase();
}

/** Trusted Windows roots present in `env` (drive roots such as `C:\` never qualify). */
export function windowsTrustedRoots(env: DirectoryTrustOptions['env'], homeDir: string): string[] {
  const get = (name: string): string | undefined => envValue(env, name, 'win32');
  const programData = get('ProgramData');
  const roots = [
    get('SystemRoot'),
    get('ProgramFiles'),
    get('ProgramFiles(x86)'),
    get('ProgramW6432'),
    programData ? path.win32.join(programData, 'chocolatey', 'bin') : undefined,
    get('LOCALAPPDATA'),
    get('APPDATA'),
    get('USERPROFILE') ?? homeDir
  ];
  const keys: string[] = [];
  for (const root of roots) {
    const value = root?.trim() ?? '';
    if (!path.win32.isAbsolute(value)) continue;
    const key = windowsKey(value);
    // A misconfigured variable (`USERPROFILE=C:\`) must not trust a whole drive or share.
    if (key === windowsKey(path.win32.parse(path.win32.normalize(value)).root)) continue;
    keys.push(key);
  }
  return [...new Set(keys)];
}

export function isUnderWindowsRoot(directory: string, roots: readonly string[]): boolean {
  const key = windowsKey(directory);
  return roots.some((root) => key === root || key.startsWith(`${root}\\`));
}

export class DirectoryTrust {
  readonly #platform: HostPlatform;
  readonly #uid: number | null;
  readonly #statDir: (directory: string) => Promise<DirectoryStats | null>;
  readonly #windowsRoots: readonly string[];

  constructor(options: DirectoryTrustOptions) {
    this.#platform = options.platform;
    this.#uid = options.uid;
    this.#statDir = options.statDir ?? defaultStatDir;
    this.#windowsRoots = options.platform === 'win32' ? windowsTrustedRoots(options.env, options.homeDir) : [];
  }

  /** `null` when `directory` may be probed, otherwise why not. */
  async check(directory: string): Promise<UntrustedReason | null> {
    if (this.#platform === 'win32') {
      return isUnderWindowsRoot(directory, this.#windowsRoots) ? null : 'outside-trusted-roots';
    }
    const stats = await this.#statDir(directory);
    if (stats === null) return 'missing';
    if ((stats.mode & WORLD_WRITABLE) !== 0) return 'world-writable';
    if (stats.uid !== 0 && stats.uid !== this.#uid) return 'foreign-owner';
    return null;
  }
}
