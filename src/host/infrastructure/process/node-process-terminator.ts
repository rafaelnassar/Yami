/**
 * `ProcessTerminator`: kills an engine's process tree, but only after a strict
 * identity check (never kill a PID that was reused by another program).
 *
 * Cost budget (shutdown stops many engines in parallel under a short deadline):
 * - an engine that already exited is detected with `kill(pid, 0)` alone — no OS query;
 * - otherwise exactly ONE strict identity read before killing (the inspector
 *   coalesces concurrent reads into one query). Its verdict is reused: exit is
 *   detected with `kill(pid, 0)` and there is no re-read after a timeout (callers
 *   that need a post-mortem verdict re-check themselves). The only other read is
 *   the POSIX re-verification before SIGKILL, when SIGTERM was ignored for the
 *   whole grace period (a cheap `/proc` / `ps` read, never PowerShell).
 *
 * - Windows: `taskkill /PID <pid> /T /F` (async, absolute System32 path).
 * - POSIX: SIGTERM to the process group (engines are spawned detached, so the
 *   group id is the pid), SIGKILL after a grace period — re-verifying identity
 *   first, since the PID may have been reused during the grace period.
 * Then waits for the PID to disappear (polling `kill(pid, 0)`).
 */
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { ProcessTerminator } from '../../application/ports/processes.ts';
import type { Logger } from '../../application/ports/system.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import { delay } from '../../../shared/kernel/async.ts';
import { type Clock, systemClock } from '../../../shared/kernel/clock.ts';
import type { CommandRunner } from './command-runner.ts';
import type { ProcessIdentityChecker } from './node-process-inspector.ts';
import { defaultSystemRoot } from './process-identity-reader.ts';
import { NodeProcessSignals, type ProcessSignal, type ProcessSignals } from './process-signals.ts';
import { isValidPid } from './process-snapshot.ts';
import { windowsSystemPaths } from './windows-process-query.ts';

const TASKKILL_TIMEOUT_MS = 8_000;

export interface NodeProcessTerminatorOptions {
  readonly platform: HostPlatform;
  /** Strict identity verdicts (`NodeProcessInspector`). */
  readonly inspector: ProcessIdentityChecker;
  readonly runner: CommandRunner;
  readonly signals?: ProcessSignals;
  readonly systemRoot?: string;
  readonly clock?: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
  /** SIGTERM → SIGKILL delay (default 3 s). */
  readonly gracePeriodMs?: number;
  /** Max wait for the PID to disappear (default 8 s). */
  readonly exitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export class NodeProcessTerminator implements ProcessTerminator {
  readonly #platform: HostPlatform;
  readonly #inspector: ProcessIdentityChecker;
  readonly #runner: CommandRunner;
  readonly #signals: ProcessSignals;
  readonly #taskkill: string;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #logger: Logger | null;
  readonly #graceMs: number;
  readonly #exitTimeoutMs: number;
  readonly #pollMs: number;

  constructor(options: NodeProcessTerminatorOptions) {
    this.#platform = options.platform;
    this.#inspector = options.inspector;
    this.#runner = options.runner;
    this.#signals = options.signals ?? new NodeProcessSignals();
    this.#taskkill = windowsSystemPaths(options.systemRoot ?? defaultSystemRoot()).taskkill;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => delay(ms));
    this.#logger = options.logger ?? null;
    this.#graceMs = options.gracePeriodMs ?? 3_000;
    this.#exitTimeoutMs = options.exitTimeoutMs ?? 8_000;
    this.#pollMs = options.pollIntervalMs ?? 150;
  }

  async terminate(identity: ProcessIdentity): Promise<boolean> {
    const { pid } = identity;
    if (!isValidPid(pid)) return false;
    if (!this.#running(pid)) return true;
    const verdict = await this.#inspector.check(identity);
    if (verdict === 'gone') return true;
    if (verdict === 'mismatch') {
      this.#logger?.warn('process kill refused: identity mismatch (PID reuse)', { pid });
      return false;
    }
    const gone = this.#platform === 'win32' ? await this.#killWindows(pid) : await this.#killPosix(identity);
    if (!gone) this.#logger?.warn('process kill incomplete: still running', { pid });
    return gone;
  }

  /** EPERM counts as gone: an engine we launched runs as our user, so it is someone else's PID now. */
  #running(pid: number): boolean {
    return this.#signals.probe(pid) === 'running';
  }

  async #killWindows(pid: number): Promise<boolean> {
    const result = await this.#runner.run(this.#taskkill, ['/PID', String(pid), '/T', '/F'], {
      timeoutMs: TASKKILL_TIMEOUT_MS
    });
    if (result.error) this.#logger?.warn('taskkill failed to run', { pid, error: result.error });
    return this.#waitForExit(pid, null);
  }

  async #killPosix(identity: ProcessIdentity): Promise<boolean> {
    this.#signalTree(identity.pid, 'SIGTERM');
    return this.#waitForExit(identity.pid, identity);
  }

  /** Group first (the whole engine tree), the single PID as a fallback. */
  #signalTree(pid: number, signal: ProcessSignal): void {
    if (!this.#signals.send(-pid, signal)) this.#signals.send(pid, signal);
  }

  /**
   * Polls until the PID is gone. With `escalate` (POSIX), sends SIGKILL once the
   * grace period elapsed — only if the PID still belongs to the same process
   * (a zombie or a reused PID means ours already exited).
   */
  async #waitForExit(pid: number, escalate: ProcessIdentity | null): Promise<boolean> {
    const start = this.#clock.now();
    let escalated = escalate === null;
    while (this.#clock.now() - start < this.#exitTimeoutMs) {
      if (!this.#running(pid)) return true;
      if (!escalated && escalate && this.#clock.now() - start >= this.#graceMs) {
        escalated = true;
        if ((await this.#inspector.check(escalate)) !== 'alive') return true;
        this.#signalTree(pid, 'SIGKILL');
      }
      await this.#sleep(this.#pollMs);
    }
    return !this.#running(pid);
  }
}
