/**
 * Locates every tool (see `tool-locations.ts`) and reads its version, all tools in
 * parallel, each probe bounded by a timeout. Fully async (legacy used
 * `execFileSync` on the host event loop). The first existing candidate wins; a
 * python-module candidate only counts when the module actually imports.
 *
 * Probes run automatically, so they are hardened like engine runs: `system`
 * directories must pass `DirectoryTrust` (skipped ones are logged once), every
 * probe runs in a neutral cwd (never the host's launch folder, which is on the DLL
 * search path on Windows) and Python runs isolated (`-I`).
 */
import { mkdir, stat } from 'node:fs/promises';
import { TOOL_IDS, type RuntimeMode, type ToolId } from '../../../shared/domain/engine.ts';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { Logger } from '../../application/ports/system.ts';
import type { ProbedTool, ProbeSnapshot, ToolProbe } from '../../application/runtime/ports.ts';
import { ExecFileCommandRunner, type CommandRunner } from '../process/command-runner.ts';
import { firstOutputLine, succeeded } from './command-result.ts';
import { DirectoryTrust, type DirectoryStats, type UntrustedReason } from './path-trust.ts';
import type { RuntimeLayout } from './runtime-layout.ts';
import { candidatesFor, directoryOf, type Candidate, type LocationContext } from './tool-locations.ts';

export interface ToolProbeOptions {
  readonly layout: RuntimeLayout;
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly isPackaged: boolean;
  /** Neutral working directory for every probe (created when missing). */
  readonly cwd: string;
  readonly logger?: Logger;
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
  readonly isFile?: (file: string) => Promise<boolean>;
  /** Current user id (POSIX directory ownership check); defaults to `process.getuid()`. */
  readonly uid?: number | null;
  readonly statDir?: (directory: string) => Promise<DirectoryStats | null>;
}

/** Variables that would make a Python load foreign code or config. */
const SCRUBBED = ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONEXECUTABLE'];
const MAX_OUTPUT_BYTES = 64 * 1024;

export function probeEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SCRUBBED.includes(key.toUpperCase())) out[key] = value;
  }
  out['PYTHONUTF8'] = '1';
  out['PYTHONNOUSERSITE'] = '1';
  return out;
}

async function defaultIsFile(file: string): Promise<boolean> {
  const stats = await stat(file).catch(() => null);
  return stats !== null && stats.isFile();
}

interface Skipped {
  readonly directory: string;
  readonly reason: UntrustedReason;
}

export class SystemToolProbe implements ToolProbe {
  readonly #context: LocationContext;
  readonly #runner: CommandRunner;
  readonly #timeoutMs: number;
  readonly #isFile: (file: string) => Promise<boolean>;
  readonly #env: Record<string, string>;
  readonly #cwd: string;
  readonly #trust: DirectoryTrust;
  readonly #logger: Logger | null;
  /** Untrusted directories already logged (PATH does not change while the host runs). */
  readonly #reported = new Set<string>();

  constructor(options: ToolProbeOptions) {
    this.#context = {
      platform: options.platform,
      env: options.env,
      homeDir: options.homeDir,
      isPackaged: options.isPackaged,
      layout: options.layout
    };
    this.#runner = options.runner ?? new ExecFileCommandRunner();
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#isFile = options.isFile ?? defaultIsFile;
    this.#env = probeEnvironment(options.env);
    this.#cwd = options.cwd;
    this.#logger = options.logger ?? null;
    this.#trust = new DirectoryTrust({
      platform: options.platform,
      env: options.env,
      homeDir: options.homeDir,
      uid: options.uid === undefined ? (process.getuid?.() ?? null) : options.uid,
      ...(options.statDir ? { statDir: options.statDir } : {})
    });
  }

  async probe(mode: RuntimeMode): Promise<ProbeSnapshot> {
    // A missing cwd would make every spawn fail with ENOENT (read as "not installed").
    await mkdir(this.#cwd, { recursive: true }).catch(() => undefined);
    const skipped: Skipped[] = [];
    const entries = await Promise.all(
      TOOL_IDS.map(async (tool) => [tool, await this.#probeTool(tool, mode, skipped)] as const)
    );
    this.#reportSkipped(skipped);
    const tools = Object.fromEntries(entries) as Record<ToolId, ProbedTool | null>;
    return { tools, managedBinDir: this.#context.layout.binDir };
  }

  async #probeTool(tool: ToolId, mode: RuntimeMode, skipped: Skipped[]): Promise<ProbedTool | null> {
    for (const candidate of candidatesFor(tool, mode, this.#context)) {
      if (!(await this.#isFile(candidate.path))) continue;
      if (!(await this.#trusted(candidate, skipped))) continue;
      const result = await this.#runner.run(candidate.path, [...candidate.prefixArgs, ...candidate.versionArgs], {
        env: this.#env,
        cwd: this.#cwd,
        timeoutMs: this.#timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES
      });
      const ok = succeeded(result);
      if (!ok && candidate.requireProbe) continue;
      return {
        path: candidate.path,
        directory: directoryOf(candidate.path, this.#context.platform),
        source: candidate.source,
        rawVersion: ok ? firstOutputLine(result) : null,
        prefixArgs: candidate.prefixArgs
      };
    }
    return null;
  }

  async #trusted(candidate: Candidate, skipped: Skipped[]): Promise<boolean> {
    // Managed files live in our own runtime dir; `env` overrides are explicit (development only).
    if (candidate.source !== 'system') return true;
    const directory = directoryOf(candidate.path, this.#context.platform);
    const reason = await this.#trust.check(directory);
    if (reason === null) return true;
    skipped.push({ directory, reason });
    return false;
  }

  #reportSkipped(skipped: readonly Skipped[]): void {
    const fresh = skipped.filter((s) => !this.#reported.has(s.directory));
    if (fresh.length === 0) return;
    const unique = new Map(fresh.map((s) => [s.directory, s.reason]));
    for (const directory of unique.keys()) this.#reported.add(directory);
    this.#logger?.warn('ignoring tools in untrusted system directories', {
      directories: [...unique].map(([directory, reason]) => ({ directory, reason }))
    });
  }
}
