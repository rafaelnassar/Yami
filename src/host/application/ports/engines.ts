/**
 * Engine ports (implemented by `host/infrastructure/engines`).
 * An adapter knows how to invoke one engine and how to read its output; it holds
 * no state about downloads.
 */
import type { Engine } from '../../../shared/domain/engine.ts';
import type { ParsedLine } from '../../domain/engines/parsed-line.ts';
import type { SiteCredentials } from './secrets.ts';

export type HostPlatform = 'win32' | 'darwin' | 'linux';

export interface ResolvedExecutable {
  /** Absolute path of the binary to spawn (the engine exe, or python in python mode). */
  readonly path: string;
  /** Arguments that must precede engine arguments (e.g. `['-m', 'yt_dlp']`). */
  readonly prefixArgs: readonly string[];
}

export interface InvocationContext {
  readonly url: string;
  /**
   * Engine output root, passed as-is to `--destination` / `--paths`. The downloads
   * core passes `<download dir>/<engine>` to keep the per-engine layout the library expects.
   */
  readonly downloadDir: string;
  /** Private scratch directory (yt-dlp temp files), kept while the download can resume. */
  readonly tempDir: string;
  /**
   * Private per-download directory for the run's plaintext secrets (0700, wiped
   * whenever the run ends): where an engine may keep tokens it derives (gallery-dl
   * cache database). `null`/absent: keep them in memory only.
   */
  readonly secretDir?: string | null;
  readonly executable: ResolvedExecutable;
  readonly ffmpegPath: string | null;
  readonly denoPath: string | null;
  /** Decrypted per-download cookie file (inside the private job workspace) or `null`. */
  readonly cookieFile: string | null;
  /** Browser for `--cookies-from-browser` (yt-dlp) or `null`. */
  readonly browserCookies: string | null;
  /** Per-download private engine config file holding secrets (gallery-dl) or `null`. */
  readonly secretConfigFile: string | null;
  readonly platform: HostPlatform;
}

export interface Invocation {
  readonly executable: string;
  readonly args: readonly string[];
  /** Variables to set on top of the scrubbed base environment (e.g. PYTHONUTF8). */
  readonly env: Readonly<Record<string, string>>;
}

/** Optional per-run facts that make parsers more precise. */
export interface ParserContext {
  /** Private temp dir (yt-dlp `-P temp:`): outputs inside it are not final files. */
  readonly tempDir?: string | null;
  /** Engine output dir (same value as `InvocationContext.downloadDir`). */
  readonly downloadDir?: string | null;
}

export interface LineParser {
  /** Stateful per run (e.g. yt-dlp pending destination). One call per output line. */
  parse(line: string): ParsedLine;
}

export interface EngineSecrets {
  readonly siteCredentials: ReadonlyMap<string, SiteCredentials>;
}

export interface EngineAdapter {
  readonly engine: Engine;
  /** Scheduling weight (gallery-dl 1, yt-dlp 2; budget 8). */
  readonly slotWeight: number;
  buildInvocation(context: InvocationContext): Invocation;
  createParser(context?: ParserContext): LineParser;
  /**
   * Engine-specific private config file content carrying secrets, or `null` when
   * the engine needs none for this URL. Written with 0600 permissions into the job
   * workspace and passed back as `InvocationContext.secretConfigFile`.
   */
  secretConfig(url: string, secrets: EngineSecrets): { readonly fileName: string; readonly content: string } | null;
  /** Whether this engine may use `--cookies-from-browser` for the URL. */
  supportsBrowserCookies(url: string): boolean;
}

export interface EngineRegistry {
  get(engine: Engine): EngineAdapter;
}

export interface BrowserCookieDetector {
  /** Browser name for `--cookies-from-browser` (prefers a running one), `null` if none. */
  detect(): Promise<string | null>;
}

/**
 * Builds the base environment for engine processes (scrubbed + PATH entries).
 * Async: the host PATH is filtered through the directory trust policy (filesystem checks).
 */
export interface EngineEnvironment {
  base(extraPathEntries: readonly string[]): Promise<Record<string, string>>;
}
