/**
 * Main's client for the download host (utility process).
 *
 * Lifecycle: fork → wait for `{kind:'ready'}` → send `system.configure` (always first)
 * → ready. Requests carry ids and per-command timeouts (`COMMAND_SPECS`). On exit every
 * pending request fails with HOST_UNAVAILABLE and the host is restarted with backoff
 * (`RestartPolicy`); too many crashes leave it `offline` until `restart()`.
 * Requests made while (re)starting wait for readiness within their own timeout.
 * `restartWith()` stops the host gracefully (running downloads are paused and requeued),
 * waits for its process to exit, runs a task while no host process exists (e.g. moving the
 * vault aside) and starts a freshly configured one. A quit meanwhile still pauses engines.
 */
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';
import {
  COMMAND_SPECS,
  type CommandPayload,
  type CommandResult,
  type HostCommand,
  type HostEvent
} from '../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import { describeError } from '../infrastructure/logger.ts';
import { HostProcessSlot, unavailableError } from './host-client-process.ts';
import { restartWith, shutdownHost } from './host-client-restart.ts';
import type { HostClientDeps } from './host-client-types.ts';
import { PendingRequests } from './pending-requests.ts';
import { RestartPolicy } from './restart-policy.ts';

export type { ConfigurePayload, HostClientDeps } from './host-client-types.ts';

export class HostClient {
  readonly #deps: HostClientDeps;
  readonly #pending = new PendingRequests();
  readonly #statusListeners = new Set<(status: HostConnectionStatus) => void>();
  readonly #eventListeners = new Set<(event: HostEvent) => void>();
  readonly #slot: HostProcessSlot;
  #status: HostConnectionStatus = { state: 'starting' };
  /** The `lifecycle.shutdown` (pause) sent by `restartWith()`, while it is pending. */
  #restartStop: Promise<unknown> | null = null;
  /** Set while the host started by `restartWith()` is coming up. */
  #restartStarting = false;

  constructor(deps: HostClientDeps) {
    this.#deps = deps;
    const policy = new RestartPolicy({
      now: deps.now,
      ...(deps.restartDelaysMs ? { delaysMs: deps.restartDelaysMs } : {})
    });
    this.#slot = new HostProcessSlot({
      client: deps,
      pending: this.#pending,
      policy,
      onStatus: (status) => this.#setStatus(status),
      onEvent: (event) => this.#emitEvent(event)
    });
  }

  get status(): HostConnectionStatus {
    return this.#status;
  }

  get isReady(): boolean {
    return this.#slot.phase === 'ready';
  }

  onStatus(listener: (status: HostConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  start(): void {
    if (this.#slot.phase !== 'idle') return;
    this.#setStatus({ state: 'starting' });
    this.#slot.spawn('starting');
  }

  request<C extends HostCommand>(
    command: C,
    payload: CommandPayload<C>,
    timeoutMs?: number
  ): Promise<Result<CommandResult<C>, AppErrorData>> {
    // The host is our own trusted process; its response types follow the contract.
    return this.forward(command, payload, timeoutMs) as Promise<Result<CommandResult<C>, AppErrorData>>;
  }

  /** Untyped variant used by the IPC controller after it validated command + payload. */
  async forward(command: HostCommand, payload: unknown, timeoutMs?: number): Promise<Result<unknown, AppErrorData>> {
    const budget = timeoutMs ?? COMMAND_SPECS[command].timeoutMs;
    if (this.#slot.phase !== 'ready') {
      const started = this.#deps.now();
      const outcome = await this.#slot.waitReady(budget, () => this.start());
      if (outcome !== 'ready') return err(unavailableError(this.#slot.phase, outcome));
      return this.#slot.send(command, payload, Math.max(1_000, budget - (this.#deps.now() - started)));
    }
    return this.#slot.send(command, payload, budget);
  }

  /** Manual restart (renderer "reconnect" / leaving `offline`). */
  restart(): Result<null, AppErrorData> {
    if (this.#slot.phase === 'disposed') return err(appError(ErrorCode.HOST_SHUTTING_DOWN));
    // A `restartWith()` in progress starts the host itself once its task is done.
    if (this.#slot.suspended) return ok(null);
    this.#slot.policy.reset();
    this.#slot.teardown(ErrorCode.HOST_RESTARTING);
    this.#setStatus({ state: 'starting' });
    this.#slot.spawn('starting');
    return ok(null);
  }

  /**
   * Restart around `whileStopped`: a ready host is asked to stop first (`pause`: running
   * engines are stopped and requeued, so none runs unsupervised meanwhile and the next host
   * relaunches them, continuing their partial files); `whileStopped` runs once the old
   * process has exited (it may still hold files open, e.g. in `vault/` on Windows); then a
   * new host is started and configured again (`deps.configure`). Works from any phase (also
   * `offline`). Requests made meanwhile wait for readiness. Resolves once the new host is
   * ready, or with the error that kept it from starting; `HOST_TIMEOUT {command: 'exit'}`
   * when the old process did not exit in time — `whileStopped` was then skipped (the new
   * host is started anyway).
   */
  restartWith(whileStopped: () => Promise<void>): Promise<Result<null, AppErrorData>> {
    return restartWith(
      this.#slot,
      (status) => this.#setStatus(status),
      whileStopped,
      (stop) => {
        this.#restartStop = stop;
      },
      (value) => {
        this.#restartStarting = value;
      }
    );
  }

  /**
   * Graceful stop: running downloads are paused (resumable), then the process is killed.
   * During a `restartWith()` the engines are paused too: by its own pending stop request,
   * or by the host it is starting (which may relaunch the requeued downloads) once ready.
   * Everything shares the `lifecycle.shutdown` budget (the quit sequence caps it as well).
   */
  shutdown(): Promise<void> {
    return shutdownHost(
      this.#slot,
      this.#restartStop,
      this.#restartStarting,
      (timeoutMs) => this.request('lifecycle.shutdown', { mode: 'pause' }, timeoutMs),
      () => this.dispose()
    );
  }

  dispose(): void {
    if (this.#slot.phase === 'disposed') return;
    this.#slot.dispose();
  }

  #emitEvent(event: HostEvent): void {
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#deps.logger.error('host event listener failed', describeError(error));
      }
    }
  }

  #setStatus(status: HostConnectionStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) {
      try {
        listener(status);
      } catch (error) {
        this.#deps.logger.error('host status listener failed', describeError(error));
      }
    }
  }
}
