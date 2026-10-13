/**
 * `ProcessLauncher`: spawns an engine detached (survives a host crash), without
 * a shell, hidden on Windows, with stdout+stderr redirected to a private log
 * file, and captures its identity right after spawn.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { LaunchedProcess, LaunchSpec, ProcessExit, ProcessLauncher } from '../../application/ports/processes.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import { type Clock, systemClock } from '../../../shared/kernel/clock.ts';
import { type AppErrorData, ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { ProcessIdentityReader } from './process-snapshot.ts';

export interface NodeProcessLauncherOptions {
  readonly platform: HostPlatform;
  readonly reader: ProcessIdentityReader;
  readonly clock?: Clock;
}

function detailOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof code === 'string' ? `${code}: ${message}` : message).slice(0, 300);
}

function internal(detail: string): AppErrorData {
  return appError(ErrorCode.INTERNAL, { detail });
}

/** Resolves once the child really started, or with the spawn error. */
function whenSpawned(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve(null);
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      resolve(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export class NodeProcessLauncher implements ProcessLauncher {
  readonly #reader: ProcessIdentityReader;
  readonly #clock: Clock;
  readonly #path: typeof path.posix;

  constructor(options: NodeProcessLauncherOptions) {
    this.#reader = options.reader;
    this.#clock = options.clock ?? systemClock;
    this.#path = options.platform === 'win32' ? path.win32 : path.posix;
  }

  async launch(spec: LaunchSpec): Promise<Result<LaunchedProcess, AppErrorData>> {
    // A relative executable would be searched in PATH/cwd — never allowed.
    if (!this.#path.isAbsolute(spec.executable)) return err(internal('executable must be an absolute path'));

    let log: FileHandle;
    try {
      await mkdir(this.#path.dirname(spec.logFile), { recursive: true });
      log = await open(spec.logFile, 'w', 0o600);
    } catch (error) {
      return err(internal(`cannot open log: ${detailOf(error)}`));
    }

    let child: ChildProcess;
    try {
      child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      await log.close().catch(() => undefined);
      return err(internal(`spawn failed: ${detailOf(error)}`));
    }

    // Subscribe before anything async so a fast exit is never missed.
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const spawnError = await whenSpawned(child);
    // The child holds its own copy of the descriptor.
    await log.close().catch(() => undefined);
    if (spawnError || child.pid === undefined) {
      return err(internal(`spawn failed: ${detailOf(spawnError ?? 'no pid')}`));
    }
    // Late errors (e.g. a failed kill) must never become uncaught exceptions.
    child.on('error', () => undefined);
    child.unref();

    const identity = await this.#capture(child.pid, spec.executable);
    return ok({ identity, exited });
  }

  async #capture(pid: number, executable: string): Promise<ProcessIdentity> {
    const fallbackImage = this.#path.basename(executable).toLowerCase() || null;
    let snapshot = null;
    try {
      snapshot = await this.#reader.read(pid);
    } catch {
      snapshot = null;
    }
    return {
      pid,
      imageName: snapshot?.imageName ?? fallbackImage,
      startToken: snapshot?.startToken ?? null,
      startTokenSource: snapshot?.startToken ? snapshot.startTokenSource : null,
      executable,
      capturedAt: this.#clock.now()
    };
  }
}
