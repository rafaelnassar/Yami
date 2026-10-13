/**
 * Where each tool is looked up, in priority order (pure; platform injected):
 *   1. managed (`<runtime>/bin`, `<runtime>/python`),
 *   2. `YAMI_*` environment overrides — development builds only,
 *   3. absolute directories of the system PATH (relative entries such as `.` are
 *      ignored),
 *   4. well-known install locations of package managers (WinGet links,
 *      `%ProgramFiles%`, Homebrew, `~/.deno/bin`, `~/.local/bin`).
 * `system` candidates (3, 4) are only run once their directory passes the trust
 * check of `path-trust.ts` (done by the probe: it needs the filesystem). Fixed
 * directories any local user can create (`C:\Tools`, `C:\ffmpeg`) are not
 * listed at all (legacy looked there).
 * Python mode runs the engines as modules of the managed Python only, in
 * isolated mode (`PYTHON_ISOLATED_ARGS`).
 */
import path from 'node:path';
import type { RuntimeMode, ToolId, ToolSource } from '../../../shared/domain/engine.ts';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { RuntimeLayout } from './runtime-layout.ts';

export interface LocationContext {
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly isPackaged: boolean;
  readonly layout: RuntimeLayout;
}

export interface Candidate {
  readonly path: string;
  readonly source: ToolSource;
  /** Arguments before the tool's own arguments (python mode `-m <module>`). */
  readonly prefixArgs: readonly string[];
  /** Arguments that print the version. */
  readonly versionArgs: readonly string[];
  /** A python-module candidate only counts when the module imports (probe succeeds). */
  readonly requireProbe: boolean;
}

const ENV_OVERRIDES: Readonly<Record<ToolId, string>> = {
  'gallery-dl': 'YAMI_GALLERY_DL',
  'yt-dlp': 'YAMI_YT_DLP',
  deno: 'YAMI_DENO_BIN',
  ffmpeg: 'YAMI_FFMPEG',
  python: 'YAMI_PYTHON_BIN'
};

const PYTHON_MODULES = { 'gallery-dl': 'gallery_dl', 'yt-dlp': 'yt_dlp' } as const;

/**
 * Interpreter options for every run of the managed Python (probes, engines, pip).
 * `-I` (isolated): the cwd / script dir is not put on `sys.path` (a `yt_dlp.py`
 * next to the process would otherwise be imported), and `PYTHON*` variables and
 * the user site-packages are ignored. Because `-I` also ignores `PYTHONUTF8` /
 * `PYTHONIOENCODING` (set by the engine environment), `-X utf8` keeps the output
 * UTF-8 — the engines' file-name lines are parsed as UTF-8.
 */
export const PYTHON_ISOLATED_ARGS: readonly string[] = ['-I', '-X', 'utf8'];

export function envValue(env: LocationContext['env'], name: string, platform: HostPlatform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Absolute PATH directories. Only Windows strips blanks and quotes (`"C:\x"`); on POSIX `"/x"` is relative. */
function pathDirs(context: LocationContext): string[] {
  const api = context.layout.pathApi();
  const windows = context.platform === 'win32';
  const raw = envValue(context.env, 'PATH', context.platform) ?? '';
  return raw
    .split(windows ? ';' : ':')
    .map((d) => (windows ? d.trim().replace(/^"(.*)"$/, '$1') : d))
    .filter((d) => d.length > 0 && api.isAbsolute(d));
}

function wellKnownDirs(tool: ToolId, context: LocationContext): string[] {
  const { platform, homeDir } = context;
  const api = context.layout.pathApi();
  if (platform === 'win32') {
    const localAppData = envValue(context.env, 'LOCALAPPDATA', platform) ?? api.join(homeDir, 'AppData', 'Local');
    const programFiles = envValue(context.env, 'ProgramFiles', platform) ?? 'C:\\Program Files';
    const dirs = [api.join(localAppData, 'Microsoft', 'WinGet', 'Links')];
    if (tool === 'deno') dirs.push(api.join(homeDir, '.deno', 'bin'));
    if (tool === 'ffmpeg') dirs.push(api.join(programFiles, 'ffmpeg', 'bin'));
    return dirs;
  }
  const dirs = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/usr/local/bin', '/usr/bin'];
  if (tool === 'deno') dirs.unshift(api.join(homeDir, '.deno', 'bin'));
  if (tool === 'gallery-dl' || tool === 'yt-dlp') dirs.push(api.join(homeDir, '.local', 'bin'));
  return dirs;
}

function versionArgs(tool: ToolId): readonly string[] {
  // ffmpeg documents `-version`; legacy relied on `--version` being accepted.
  return tool === 'ffmpeg' ? ['-version'] : ['--version'];
}

function pythonExecutables(context: LocationContext): Array<{ path: string; source: ToolSource }> {
  const list: Array<{ path: string; source: ToolSource }> = [
    { path: context.layout.pythonExecutable, source: 'managed' }
  ];
  const override = context.isPackaged ? undefined : envValue(context.env, ENV_OVERRIDES.python, context.platform);
  if (override) list.push({ path: override, source: 'env' });
  return list;
}

function dedupe(candidates: Candidate[], platform: HostPlatform): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${platform === 'win32' ? c.path.toLowerCase() : c.path}|${c.prefixArgs.join(' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function candidatesFor(tool: ToolId, mode: RuntimeMode, context: LocationContext): Candidate[] {
  const { layout, platform } = context;
  if (tool === 'python') {
    return pythonExecutables(context).map((p) => ({
      ...p,
      prefixArgs: [],
      versionArgs: [...PYTHON_ISOLATED_ARGS, '--version'],
      requireProbe: false
    }));
  }
  if (mode === 'python' && (tool === 'gallery-dl' || tool === 'yt-dlp')) {
    const prefixArgs = [...PYTHON_ISOLATED_ARGS, '-m', PYTHON_MODULES[tool]];
    return pythonExecutables(context).map((p) => ({
      path: p.path,
      source: 'python' as const,
      prefixArgs,
      versionArgs: ['--version'],
      requireProbe: true
    }));
  }
  const exe = layout.exeName(tool);
  const api = layout.pathApi();
  const make = (file: string, source: ToolSource): Candidate => ({
    path: file,
    source,
    prefixArgs: [],
    versionArgs: versionArgs(tool),
    requireProbe: false
  });
  const list: Candidate[] = [make(layout.binPath(tool), 'managed')];
  const override = context.isPackaged ? undefined : envValue(context.env, ENV_OVERRIDES[tool], platform);
  if (override && api.isAbsolute(override)) list.push(make(override, 'env'));
  for (const dir of [...pathDirs(context), ...wellKnownDirs(tool, context)])
    list.push(make(api.join(dir, exe), 'system'));
  return dedupe(list, platform);
}

export function directoryOf(file: string, platform: HostPlatform): string {
  return (platform === 'win32' ? path.win32 : path.posix).dirname(file);
}
