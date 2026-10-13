/**
 * Signal delivery / PID liveness, behind an interface so inspector and
 * terminator logic can be tested without real processes.
 */

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

/**
 * `kill(pid, 0)` outcome:
 * - `running`: the PID exists and we may signal it;
 * - `missing`: `ESRCH` (or an invalid PID) — nothing runs under that PID;
 * - `denied`: `EPERM` — something runs under that PID but we may not signal it.
 *   An engine we launched runs as our user, so strict checks read this as
 *   "not ours"; cheap non-strict checks let the identity comparison decide.
 */
export type PidProbe = 'running' | 'missing' | 'denied';

export interface ProcessSignals {
  probe(pid: number): PidProbe;
  /**
   * Returns false when the target does not exist (or may not be signalled).
   * A negative `pid` targets the process group `-pid` (POSIX).
   */
  send(pid: number, signal: ProcessSignal): boolean;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export class NodeProcessSignals implements ProcessSignals {
  probe(pid: number): PidProbe {
    if (!Number.isInteger(pid) || pid <= 0) return 'missing';
    try {
      process.kill(pid, 0);
      return 'running';
    } catch (error) {
      return errorCode(error) === 'EPERM' ? 'denied' : 'missing';
    }
  }

  send(pid: number, signal: ProcessSignal): boolean {
    if (!Number.isInteger(pid) || pid === 0) return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
