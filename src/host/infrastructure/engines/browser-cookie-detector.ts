/**
 * Picks the browser for yt-dlp `--cookies-from-browser` (spec 03 §5.5).
 *
 * Order: a valid `YAMI_COOKIES_FROM_BROWSER` (legacy `ARTERMIS_…`) override; else
 * the first installed browser that is running; else the first installed one; else
 * `null`. Fully asynchronous: the process list comes from an injected command
 * runner (no shell, with a timeout) and results are cached for a few seconds.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserCookieDetector, HostPlatform } from '../../application/ports/engines.ts';
import { singleFlight } from '../../../shared/kernel/async.ts';
import { systemClock, type Clock } from '../../../shared/kernel/clock.ts';
import { browserCandidates, type BrowserCandidate } from './browser-candidates.ts';
import { normalizeBrowserCookieSpec } from './browser-cookie-spec.ts';

/** Structural subset of the process infrastructure's `CommandRunner`. */
export interface ProcessListRunner {
  run(
    file: string,
    args: readonly string[],
    options: { readonly timeoutMs: number }
  ): Promise<{ readonly stdout: string; readonly code: number | null }>;
}

export interface DirectoryProbe {
  isDirectory(dirPath: string): Promise<boolean>;
}

export const nodeDirectoryProbe: DirectoryProbe = {
  async isDirectory(dirPath: string): Promise<boolean> {
    try {
      return (await stat(dirPath)).isDirectory();
    } catch {
      return false;
    }
  }
};

export interface BrowserCookieDetectorOptions {
  readonly platform: HostPlatform;
  /** Host environment (overrides, `LOCALAPPDATA`, `SystemRoot`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly runner: ProcessListRunner;
  readonly fs?: DirectoryProbe;
  readonly clock?: Clock;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_CACHE_MS = 5000;
const DEFAULT_TIMEOUT_MS = 3000;
const OVERRIDE_VARIABLES = ['YAMI_COOKIES_FROM_BROWSER', 'ARTERMIS_COOKIES_FROM_BROWSER'];

export class SystemBrowserCookieDetector implements BrowserCookieDetector {
  readonly #options: BrowserCookieDetectorOptions;
  readonly #fs: DirectoryProbe;
  readonly #clock: Clock;
  readonly #cacheMs: number;
  readonly #probeOnce: () => Promise<string | null>;
  #cached: { readonly at: number; readonly value: string | null } | null = null;

  constructor(options: BrowserCookieDetectorOptions) {
    this.#options = options;
    this.#fs = options.fs ?? nodeDirectoryProbe;
    this.#clock = options.clock ?? systemClock;
    this.#cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    this.#probeOnce = singleFlight(() => this.#probe());
  }

  async detect(): Promise<string | null> {
    const override = this.#override();
    if (override !== null) return override;
    const cached = this.#cached;
    if (cached && this.#clock.now() - cached.at < this.#cacheMs) return cached.value;
    const value = await this.#probeOnce();
    this.#cached = { at: this.#clock.now(), value };
    return value;
  }

  #getEnv(name: string): string | undefined {
    const env = this.#options.env;
    if (this.#options.platform !== 'win32') return env[name];
    const upper = name.toUpperCase();
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase() === upper && value !== undefined) return value;
    }
    return undefined;
  }

  /** Invalid overrides are ignored (they would make yt-dlp abort before downloading). */
  #override(): string | null {
    for (const name of OVERRIDE_VARIABLES) {
      const value = this.#getEnv(name);
      if (value?.trim()) return normalizeBrowserCookieSpec(value);
    }
    return null;
  }

  async #probe(): Promise<string | null> {
    const all = browserCandidates({
      platform: this.#options.platform,
      homeDir: this.#options.homeDir,
      getEnv: (name) => this.#getEnv(name)
    });
    const installedFlags = await Promise.all(all.map((candidate) => this.#fs.isDirectory(candidate.profileDir)));
    const installed = all.filter((_, index) => installedFlags[index] === true);
    const first = installed[0];
    if (!first) return null;
    const running = await this.#runningProcessNames();
    const live = installed.find((candidate) => isRunning(candidate, running));
    return (live ?? first).browser;
  }

  async #runningProcessNames(): Promise<ReadonlySet<string>> {
    const windows = this.#options.platform === 'win32';
    // Absolute System32 path: a bare `tasklist` could resolve from the working directory on Windows.
    const file = windows
      ? path.win32.join(this.#getEnv('SystemRoot') || 'C:\\Windows', 'System32', 'tasklist.exe')
      : 'ps';
    const args = windows ? ['/fo', 'csv', '/nh'] : ['-A', '-o', 'comm='];
    try {
      const result = await this.#options.runner.run(file, args, {
        timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      if (result.code !== 0) return new Set();
      return windows ? parseTasklistNames(result.stdout) : parsePsNames(result.stdout);
    } catch {
      return new Set();
    }
  }
}

function isRunning(candidate: BrowserCandidate, running: ReadonlySet<string>): boolean {
  return candidate.processNames.some((name) => running.has(name));
}

/** `"chrome.exe","1234","Console",…` → first CSV column, lower-cased. */
export function parseTasklistNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const name = /^\s*"([^"]+)"/.exec(line)?.[1]?.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/** `ps -o comm=` lines; macOS prints full executable paths, so keep the base name (Q21). */
export function parsePsNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1).toLowerCase();
    if (base) names.add(base);
  }
  return names;
}
