/**
 * Directory layout of the app (pure; Electron values are injected by the bootstrap).
 * See docs/ARCHITECTURE.md §8.
 */
import path from 'node:path';

export type Platform = 'win32' | 'darwin' | 'linux';

export interface AppPathsInput {
  readonly platform: Platform;
  /** `app.getPath('userData')` */
  readonly userData: string;
  /** `app.getPath('logs')` */
  readonly logs: string;
  /** `app.getPath('home')` */
  readonly home: string;
  /** `app.getAppPath()` */
  readonly appPath: string;
  /** `process.resourcesPath` */
  readonly resourcesPath: string;
  /** `process.execPath` */
  readonly execPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (dir: string) => boolean;
}

export interface AppPaths {
  readonly userData: string;
  /** Host database, jobs, vault (`userData/data`). */
  readonly dataDir: string;
  /** Managed tools (outside the roaming profile on Windows: they are large and machine-specific). */
  readonly runtimeDir: string;
  readonly logsDir: string;
  /**
   * Scratch space (`userData/tmp`), never the shared system temp dir: other local users
   * must not be able to pre-create or swap what we write there. The bootstrap makes it
   * private (0700, ours) before use — see `private-dir.ts`.
   */
  readonly tempDir: string;
  /** Legacy `~/.yami` data directory, imported once by the host; `null` when absent. */
  readonly legacyDir: string | null;
  /** Directories that must never become the download directory. */
  readonly protectedDirs: readonly string[];
  readonly settingsFile: string;
  /** Host secret vault (`dataDir/vault`: encrypted cookies, credentials) — holds `vaultKeyFile`. */
  readonly vaultDir: string;
  readonly vaultKeyFile: string;
  readonly clipboardDismissedFile: string;
  readonly thumbnailsDir: string;
}

function runtimeDirFor(input: AppPathsInput): string {
  const { platform, env } = input;
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] || path.win32.join(input.home, 'AppData', 'Local');
    return path.win32.join(localAppData, 'Yami', 'runtime');
  }
  if (platform === 'darwin') return path.posix.join(input.userData, 'runtime');
  const xdgData = env['XDG_DATA_HOME'] || path.posix.join(input.home, '.local', 'share');
  return path.posix.join(xdgData, 'yami', 'runtime');
}

export function resolveAppPaths(input: AppPathsInput): AppPaths {
  const pathApi = input.platform === 'win32' ? path.win32 : path.posix;
  const join = (...parts: string[]): string => pathApi.join(...parts);
  const dirname = (target: string): string => pathApi.dirname(target);
  const runtimeDir = runtimeDirFor(input);
  const legacy = join(input.home, '.yami');
  const protectedDirs = [
    input.userData,
    runtimeDir,
    input.logs,
    input.appPath,
    input.resourcesPath,
    dirname(input.execPath)
  ].filter((dir, index, all) => dir.length > 0 && all.indexOf(dir) === index);

  return {
    userData: input.userData,
    dataDir: join(input.userData, 'data'),
    runtimeDir,
    logsDir: input.logs,
    tempDir: join(input.userData, 'tmp'),
    legacyDir: input.exists(legacy) ? legacy : null,
    protectedDirs,
    settingsFile: join(input.userData, 'settings.json'),
    vaultDir: join(input.userData, 'data', 'vault'),
    vaultKeyFile: join(input.userData, 'data', 'vault', 'key.bin'),
    clipboardDismissedFile: join(input.userData, 'clipboard-dismissed.json'),
    thumbnailsDir: join(input.userData, 'cache', 'thumbnails')
  };
}
