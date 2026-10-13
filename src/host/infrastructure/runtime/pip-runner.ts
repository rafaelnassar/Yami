/**
 * Runs pip of the managed Python:
 *   python -I -X utf8 -m pip install --isolated --disable-pip-version-check --no-input
 *          --only-binary=:all: --require-hashes --no-deps -r <private lockfile>
 * The lockfile lists every wheel of the platform's hash lock (manifest) and is
 * written 0600 into a fresh private directory under the runtime `.tmp` (removed
 * afterwards; `.tmp` leftovers are cleaned at startup). Without a lock (dev builds
 * only — the application enforces that) the pinned requirements are passed instead
 * and pip resolves their dependencies itself, unhashed.
 * No shell; requirements and lock entries are validated (`name[extras]==version`,
 * hex digests), so they can never be pip options.
 *
 * Hardening: `-I` keeps the cwd off `sys.path`; `--isolated` (plus scrubbing
 * `PIP_*`) ignores pip's environment variables and user/site config files, so an
 * index URL or trusted host cannot be injected; `--only-binary=:all:` refuses
 * source distributions, whose `setup.py` would run arbitrary code at install time;
 * `--require-hashes --no-deps` installs exactly the locked files and nothing else.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { PipInstallRequest, PipRunner } from '../../application/runtime/ports.ts';
import { ABORTED, ExecFileCancellableRunner, type CancellableCommandRunner } from './cancellable-command.ts';
import { succeeded } from './command-result.ts';
import { renderLockfile } from './pip-lockfile.ts';
import { PYTHON_ISOLATED_ARGS } from './tool-locations.ts';
import { probeEnvironment } from './tool-probe.ts';

export interface PipRunnerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Neutral working directory (never the download dir; created when missing). */
  readonly cwd: string;
  /** Private scratch for the lockfile (the runtime `.tmp`, same owner as the managed tools). */
  readonly tmpDir: string;
  readonly runner?: CancellableCommandRunner;
  readonly timeoutMs?: number;
}

const REQUIREMENT = /^[A-Za-z0-9._-]+(\[[A-Za-z0-9._,-]+\])?==[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export const PIP_INSTALL_ARGS: readonly string[] = [
  ...PYTHON_ISOLATED_ARGS,
  '-m',
  'pip',
  'install',
  '--isolated',
  '--disable-pip-version-check',
  '--no-input',
  '--only-binary=:all:'
];

/** Appended (with `-r <lockfile>`) when installing a hash lock. */
export const PIP_LOCKED_ARGS: readonly string[] = ['--require-hashes', '--no-deps'];

const LOCKFILE_NAME = 'requirements.lock.txt';

interface LockfileLocation {
  readonly dir: string;
  readonly file: string;
}

/** Probe environment without any `PIP_*` variable (names are case-insensitive on Windows). */
export function pipEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out = probeEnvironment(env);
  for (const key of Object.keys(out)) if (key.toUpperCase().startsWith('PIP_')) delete out[key];
  return out;
}

export class ManagedPipRunner implements PipRunner {
  readonly #runner: CancellableCommandRunner;
  readonly #env: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #cwd: string;
  readonly #tmpDir: string;

  constructor(options: PipRunnerOptions) {
    this.#runner = options.runner ?? new ExecFileCancellableRunner();
    this.#env = pipEnvironment(options.env);
    this.#timeoutMs = options.timeoutMs ?? 20 * 60_000;
    this.#cwd = options.cwd;
    this.#tmpDir = options.tmpDir;
  }

  async install(
    pythonExecutable: string,
    request: PipInstallRequest,
    onLine: (line: string) => void,
    signal: AbortSignal
  ): Promise<Result<void, AppErrorData>> {
    const { requirements, lock } = request;
    const invalid = requirements.find((r) => !REQUIREMENT.test(r));
    if (invalid !== undefined || requirements.length === 0) {
      return err({ code: ErrorCode.VALIDATION_FAILED, params: { detail: `pip requirement: ${invalid ?? '(none)'}` } });
    }
    await mkdir(this.#cwd, { recursive: true }).catch(() => undefined);
    if (lock === null) return this.#pip(pythonExecutable, [...PIP_INSTALL_ARGS, ...requirements], onLine, signal);

    const lockfile = renderLockfile(lock);
    if (!lockfile.ok) return lockfile;
    const written = await this.#writeLockfile(lockfile.value);
    if (!written.ok) return written;
    try {
      const args = [...PIP_INSTALL_ARGS, ...PIP_LOCKED_ARGS, '-r', written.value.file];
      return await this.#pip(pythonExecutable, args, onLine, signal);
    } finally {
      await rm(written.value.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** `<tmpDir>/pip-lock-XXXXXX/requirements.lock.txt`; mkdtemp makes the directory 0700, the file is 0600. */
  async #writeLockfile(content: string): Promise<Result<LockfileLocation, AppErrorData>> {
    let dir: string | null = null;
    try {
      await mkdir(this.#tmpDir, { recursive: true });
      dir = await mkdtemp(path.join(this.#tmpDir, 'pip-lock-'));
      const file = path.join(dir, LOCKFILE_NAME);
      await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return ok({ dir, file });
    } catch (error) {
      if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      const detail = `lockfile: ${String(error).slice(0, 200)}`;
      return err({ code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail } });
    }
  }

  async #pip(
    pythonExecutable: string,
    args: readonly string[],
    onLine: (line: string) => void,
    signal: AbortSignal
  ): Promise<Result<void, AppErrorData>> {
    let lastError = '';
    const result = await this.#runner.run(pythonExecutable, args, {
      env: this.#env,
      cwd: this.#cwd,
      timeoutMs: this.#timeoutMs,
      signal,
      // Output is consumed line by line; the buffer only bounds memory.
      maxBuffer: 16 * 1024 * 1024,
      onLine: (line) => {
        if (/^ERROR:/i.test(line.trim())) lastError = line.trim();
        onLine(line);
      }
    });
    if (result.error === ABORTED || signal.aborted) return err({ code: ErrorCode.CANCELLED });
    if (succeeded(result)) return ok();
    const detail =
      result.error === 'ENOENT'
        ? 'python not found'
        : result.error === 'ETIMEDOUT'
          ? 'pip timed out'
          : lastError || result.error || `pip exit code ${String(result.code)}`;
    return err({ code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: detail.slice(0, 300) } });
  }
}
