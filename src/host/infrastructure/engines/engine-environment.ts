/**
 * Base environment of engine download runs (`LaunchService`, spec 03 Q30): the
 * host environment minus variables that can hijack Python/the engines or leak host
 * internals, plus UTF-8 output and the managed tool directories in front of PATH.
 * Version probes and pip do not use it: they run with `probeEnvironment`
 * (`runtime/tool-probe.ts`), only start executables that already passed the trust
 * check (by absolute path) and never reach ffmpeg/Deno through PATH.
 *
 * PATH only keeps directories that pass the same `DirectoryTrust` policy as tool
 * discovery (system directories such as `%SystemRoot%\System32` or `/usr/bin`
 * pass). yt-dlp looks ffmpeg/ffprobe (and its default JS runtime) up in PATH when
 * the app did not resolve them, and gallery-dl reaches ffmpeg through its `ytdl`
 * downloader: an entry another local user can write to (e.g. `C:\ffmpeg\bin` on a
 * shared Windows machine) would hand them code execution even though discovery
 * refused it. The extra entries (managed `bin/`, the resolved ffmpeg/Deno
 * directories) were vetted by the probe and are kept as given. The OS binary
 * directories (`/usr/bin`, `/bin`, …) stay even when owned by another uid: in
 * user-namespace sandboxes (Flatpak, containers) root shows up as `nobody`, and
 * without them the engines could not even start helper processes.
 *
 * Windows environment names are case-insensitive: lookups, deletions and PATH
 * handling honour that (a copied env may carry `Path`, not `PATH` — Q5). Only
 * Windows strips blanks and quotes around PATH entries (`"C:\Program Files\x"`);
 * on POSIX they are part of the name, so `"/usr/bin"` is a relative entry.
 */
import path from 'node:path';
import type { EngineEnvironment, HostPlatform } from '../../application/ports/engines.ts';
import type { Logger } from '../../application/ports/system.ts';
import type { UntrustedReason } from '../runtime/path-trust.ts';

/** Forces UTF-8 stdio in Python (and PyInstaller-frozen) engines (Q3). */
export const ENGINE_UTF8_ENV: Readonly<Record<string, string>> = Object.freeze({
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8'
});

/** Upper-case names removed from the engine environment. */
const SCRUBBED_NAMES = new Set([
  // Python start-up hijacks and flags that break UTF-8 or engine start-up.
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PYTHONNOUSERSITE',
  'PYTHONWARNINGS',
  'PYTHONBREAKPOINT',
  'PYTHONLEGACYWINDOWSSTDIO',
  'PYTHONLEGACYWINDOWSFSENCODING',
  'PYTHONUTF8',
  'PYTHONIOENCODING',
  // Engine config overrides (the app always passes its own options).
  'GALLERY_DL_CONFIG',
  'GALLERYDL_CONFIG',
  'YTDLP_CONFIG',
  'YT_DL_CONFIG',
  'NODE_OPTIONS'
]);

/** Host internals (`ELECTRON_RUN_AS_NODE`, `YAMI_DATA_DIR`…) must not reach the engines. */
const SCRUBBED_PREFIXES = ['ELECTRON_', 'YAMI_', 'ARTERMIS_'];

/** POSIX system binary directories: exempt from the owner check (never from the world-writable one). */
const POSIX_SYSTEM_DIRS: ReadonlySet<string> = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin']);

export type SourceEnvironment = Readonly<Record<string, string | undefined>>;

/** Trust policy for PATH entries (`DirectoryTrust`): `null` when the directory may stay. */
export interface PathDirectoryTrust {
  check(directory: string): Promise<UntrustedReason | null>;
}

export class ScrubbedEngineEnvironment implements EngineEnvironment {
  readonly #source: SourceEnvironment;
  readonly #platform: HostPlatform;
  readonly #trust: PathDirectoryTrust;
  readonly #logger: Logger | null;
  /** Dropped directories already logged (PATH does not change while the host runs). */
  readonly #reported = new Set<string>();

  /** `source` is the host environment (e.g. `process.env`), read on every `base()` call. */
  constructor(
    source: SourceEnvironment,
    platform: HostPlatform,
    trust: PathDirectoryTrust,
    logger: Logger | null = null
  ) {
    this.#source = source;
    this.#platform = platform;
    this.#trust = trust;
    this.#logger = logger;
  }

  async base(extraPathEntries: readonly string[]): Promise<Record<string, string>> {
    const windows = this.#platform === 'win32';
    const env: Record<string, string> = {};
    const pathValues: string[] = [];
    let pathKey: string | null = null;

    for (const [key, value] of Object.entries(this.#source)) {
      if (typeof value !== 'string') continue;
      const name = windows ? key.toUpperCase() : key;
      if (name === 'PATH') {
        // Keep the first spelling (`Path` on Windows) and merge case-variant duplicates into it.
        pathKey ??= key;
        pathValues.push(value);
        continue;
      }
      if (SCRUBBED_NAMES.has(name) || SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      env[key] = value;
    }

    const delimiter = windows ? ';' : ':';
    const existing = await this.#trusted(pathValues.flatMap((value) => value.split(delimiter)));
    env[pathKey ?? 'PATH'] = mergePathEntries(extraPathEntries, existing, windows).join(delimiter);
    return Object.assign(env, ENGINE_UTF8_ENV);
  }

  /** Host PATH entries that pass the trust policy; relative entries (`.`, empty) never do. */
  async #trusted(entries: readonly string[]): Promise<string[]> {
    const windows = this.#platform === 'win32';
    const api = windows ? path.win32 : path.posix;
    const verdicts = await Promise.all(
      entries.map(async (entry): Promise<UntrustedReason | 'relative' | null> => {
        const directory = unquote(entry, windows);
        if (!directory || !api.isAbsolute(directory)) return 'relative';
        const reason = await this.#trust.check(directory).catch(() => 'missing' as const);
        return reason === 'foreign-owner' && this.#isSystemDir(directory) ? null : reason;
      })
    );
    const dropped = new Map<string, string>();
    const kept = entries.filter((entry, index) => {
      const reason = verdicts[index] ?? null;
      if (reason !== null && entry.trim()) dropped.set(entry, reason);
      return reason === null;
    });
    this.#report(dropped);
    return kept;
  }

  #isSystemDir(directory: string): boolean {
    if (this.#platform === 'win32') return false;
    const normalized = path.posix.normalize(directory).replace(/(.)\/+$/, '$1');
    return POSIX_SYSTEM_DIRS.has(normalized);
  }

  #report(dropped: ReadonlyMap<string, string>): void {
    const fresh = [...dropped].filter(([directory, reason]) => reason !== 'missing' && !this.#reported.has(directory));
    if (fresh.length === 0) return;
    for (const [directory] of fresh) this.#reported.add(directory);
    this.#logger?.warn('untrusted PATH entries removed from the engine environment', {
      directories: fresh.map(([directory, reason]) => ({ directory, reason }))
    });
  }
}

/** PATH entry as the OS resolves it: Windows ignores surrounding blanks and quotes, POSIX does not. */
function unquote(entry: string, windows: boolean): string {
  return windows ? entry.trim().replace(/^"(.*)"$/, '$1') : entry;
}

function pathEntryKey(entry: string, windows: boolean): string {
  const unquoted = unquote(entry, windows);
  if (!windows) return unquoted.length > 1 ? unquoted.replace(/\/+$/, '') : unquoted;
  const unified = unquoted.replace(/\//g, '\\').toLowerCase();
  return unified.length > 3 ? unified.replace(/\\+$/, '') : unified;
}

/** `first` entries in order, then `rest`; empty and duplicate entries dropped (case-insensitive on Windows). */
export function mergePathEntries(first: readonly string[], rest: readonly string[], windows: boolean): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...first, ...rest]) {
    if (!entry.trim()) continue;
    const key = pathEntryKey(entry, windows);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
