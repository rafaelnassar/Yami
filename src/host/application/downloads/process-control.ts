/**
 * Stops the engine process of a running download, safely:
 * - a run whose exit was already delivered is reported as `exited` (finish it normally);
 * - termination goes through the identity-checked `ProcessTerminator`, which
 *   resolves true once the process is gone (also when it already was) and refuses
 *   on an identity mismatch — so no OS identity read is needed up front;
 * - only when termination did not succeed is the process inspected (strict):
 *   still ours and alive → `failed` (the caller reports PROCESS_KILL_FAILED and
 *   leaves the state unchanged); otherwise it is gone → `terminated`.
 */
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import type { ProcessInspector, ProcessTerminator } from '../ports/processes.ts';
import type { Logger } from '../ports/system.ts';
import type { ActiveRun } from './download-registry.ts';

export type StopResult = 'exited' | 'terminated' | 'failed';

export interface ProcessControlDeps {
  readonly inspector: ProcessInspector;
  readonly terminator: ProcessTerminator;
  readonly logger: Logger;
}

export class ProcessControl {
  readonly #deps: ProcessControlDeps;

  constructor(deps: ProcessControlDeps) {
    this.#deps = deps;
  }

  async stop(identity: ProcessIdentity | null, run: ActiveRun | undefined): Promise<StopResult> {
    if (!identity || run?.exit) return 'exited';
    let terminated = false;
    try {
      terminated = await this.#deps.terminator.terminate(identity);
    } catch (error) {
      this.#deps.logger.warn('terminate failed', { pid: identity.pid, error: String(error) });
    }
    if (terminated) return 'terminated';
    // Refused or incomplete: only a process that is still ours and alive is a failure.
    return (await this.#alive(identity)) ? 'failed' : 'terminated';
  }

  /** Strict identity check; inspection errors count as alive (never kill/forget blindly). */
  async #alive(identity: ProcessIdentity): Promise<boolean> {
    try {
      return await this.#deps.inspector.isAlive(identity, { strict: true });
    } catch (error) {
      this.#deps.logger.warn('process inspection failed', { pid: identity.pid, error: String(error) });
      return true;
    }
  }
}
