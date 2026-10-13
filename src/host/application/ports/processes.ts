/**
 * OS process ports (implemented by `host/infrastructure/process`).
 * Everything here must be non-blocking: no `*Sync` child_process calls.
 */
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';

export interface LaunchSpec {
  readonly executable: string;
  readonly args: readonly string[];
  /** Complete environment for the child (already scrubbed by the caller). */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** stdout + stderr are appended to this file (created/truncated by the launcher). */
  readonly logFile: string;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface LaunchedProcess {
  readonly identity: ProcessIdentity;
  /**
   * Resolves when the process exits. Only available for processes launched by this
   * host instance (re-attached processes are supervised through `ProcessInspector`).
   */
  readonly exited: Promise<ProcessExit>;
}

export interface ProcessLauncher {
  /**
   * Spawns the engine detached (it survives a host crash), without a shell,
   * hidden on Windows, with stdio redirected to `spec.logFile`.
   */
  launch(spec: LaunchSpec): Promise<Result<LaunchedProcess, AppErrorData>>;
}

export interface ProcessInspector {
  /**
   * True when a process with this identity is still running.
   * `strict`: re-read identity from the OS (no cache) and require a matching image
   * name AND start token (when both sides have a comparable token).
   * Non-strict may use short-lived caches.
   */
  isAlive(identity: ProcessIdentity, options: { readonly strict: boolean }): Promise<boolean>;
  /** Batched variant: one OS query for many processes. Keyed by pid. */
  aliveMany(identities: readonly ProcessIdentity[]): Promise<ReadonlyMap<number, boolean>>;
}

export interface ProcessTerminator {
  /**
   * Terminates the process tree (Windows: `taskkill /T /F`; POSIX: SIGTERM to the
   * group, SIGKILL after a grace period). Refuses (returns false) when the identity
   * no longer matches (PID reuse). Resolves true once the process is gone.
   */
  terminate(identity: ProcessIdentity): Promise<boolean>;
}
