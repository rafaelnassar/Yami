/**
 * Process slot for the download host: spawn, handshake, crash/restart backoff,
 * teardown. Owns the child `HostProcess` and generation counter.
 */
import {
  COMMAND_SPECS,
  type CommandResult,
  type HostCommand,
  type HostEvent
} from '../../shared/contracts/host-protocol.ts';
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';
import { ErrorCode, appError, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import { describeError, type Logger } from '../infrastructure/logger.ts';
import type { Cancel } from '../infrastructure/timers.ts';
import type { HostClientDeps, HostPhase, ReadyOutcome } from './host-client-types.ts';
import { DEFAULT_EXIT_TIMEOUT_MS } from './host-client-types.ts';
import { parseHostMessage } from './host-messages.ts';
import type { PendingRequests } from './pending-requests.ts';
import type { HostProcess } from './host-process.ts';
import type { RestartPolicy } from './restart-policy.ts';

export interface HostProcessSlotDeps {
  readonly client: HostClientDeps;
  readonly pending: PendingRequests;
  readonly policy: RestartPolicy;
  readonly onStatus: (status: HostConnectionStatus) => void;
  readonly onEvent: (event: HostEvent) => void;
}

export class HostProcessSlot {
  readonly #deps: HostProcessSlotDeps;
  #phase: HostPhase = 'idle';
  #process: HostProcess | null = null;
  #generation = 0;
  #seq = 0;
  #cancelStartup: Cancel | null = null;
  #stopping = false;
  #suspended = false;
  readonly #exits = new WeakMap<HostProcess, Promise<void>>();

  constructor(deps: HostProcessSlotDeps) {
    this.#deps = deps;
  }

  get phase(): HostPhase {
    return this.#phase;
  }

  set phase(value: HostPhase) {
    this.#phase = value;
  }

  get process(): HostProcess | null {
    return this.#process;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  set stopping(value: boolean) {
    this.#stopping = value;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  set suspended(value: boolean) {
    this.#suspended = value;
  }

  get logger(): Logger {
    return this.#deps.client.logger;
  }

  get policy(): RestartPolicy {
    return this.#deps.policy;
  }

  get clientDeps(): HostClientDeps {
    return this.#deps.client;
  }

  isClosing(): boolean {
    return this.#phase === 'disposed' || this.#stopping;
  }

  spawn(phase: 'starting' | 'restarting'): void {
    this.#phase = phase;
    const generation = (this.#generation += 1);
    let child: HostProcess;
    try {
      child = this.#deps.client.spawn();
    } catch (error) {
      this.#deps.client.logger.error('host spawn failed', describeError(error));
      this.crash(generation, appError(ErrorCode.HOST_UNAVAILABLE, { detail: 'spawn' }));
      return;
    }
    this.#process = child;
    let markExited: () => void = () => undefined;
    this.#exits.set(
      child,
      new Promise<void>((resolve) => {
        markExited = resolve;
      })
    );
    child.onMessage((message) => this.onMessage(generation, message));
    child.onExit((code) => {
      markExited();
      if (generation !== this.#generation) return;
      this.#process = null;
      this.#deps.client.logger.warn('host exited', { code, phase: this.#phase });
      this.crash(generation, appError(ErrorCode.HOST_UNAVAILABLE, { exitCode: code }));
    });
    this.#cancelStartup = this.#deps.client.timers.schedule(
      () => this.crash(generation, appError(ErrorCode.HOST_TIMEOUT, { command: 'ready' })),
      this.#deps.client.readyTimeoutMs ?? 20_000
    );
  }

  onMessage(generation: number, raw: unknown): void {
    if (generation !== this.#generation) return;
    const message = parseHostMessage(raw);
    if (!message) {
      this.#deps.client.logger.warn('malformed host message ignored');
      return;
    }
    if (message.kind === 'ready') {
      if (this.#phase !== 'starting' && this.#phase !== 'restarting') return;
      this.#cancelStartup?.();
      this.#cancelStartup = null;
      void this.configure(generation, message.pid);
      return;
    }
    if (message.kind === 'response') {
      this.#deps.pending.settle(message.id, message.ok ? ok(message.data) : err(message.error));
      return;
    }
    this.#deps.onEvent(message.event);
  }

  async configure(generation: number, pid: number): Promise<void> {
    const payload = await this.#deps.client.configure();
    if (generation !== this.#generation) return;
    if (!payload.ok) {
      this.#deps.client.logger.error('host configuration unavailable', { code: payload.error.code });
      this.teardown(ErrorCode.HOST_UNAVAILABLE);
      this.goOffline(payload.error);
      return;
    }
    const result = await this.send('system.configure', payload.value, COMMAND_SPECS['system.configure'].timeoutMs);
    if (generation !== this.#generation) return;
    if (!result.ok) {
      this.crash(generation, result.error);
      return;
    }
    this.#phase = 'ready';
    this.#deps.client.logger.info('host ready', { pid });
    this.#deps.onStatus({ state: 'ready' });
    this.notifyReadyWaiters('ready');
    const configured = result.value as CommandResult<'system.configure'>;
    this.onMessage(generation, { kind: 'event', event: { type: 'state', state: configured.state } });
  }

  send(command: HostCommand, payload: unknown, timeoutMs: number): Promise<Result<unknown, AppErrorData>> {
    const child = this.#process;
    if (!child) return Promise.resolve(err(appError(ErrorCode.HOST_UNAVAILABLE)));
    const id = `m${(this.#seq += 1)}`;
    return new Promise((resolve) => {
      const cancel = this.#deps.client.timers.schedule(() => {
        this.#deps.pending.drop(id);
        resolve(err(appError(ErrorCode.HOST_TIMEOUT, { command })));
      }, timeoutMs);
      this.#deps.pending.add(id, resolve, cancel);
      try {
        child.postMessage({ kind: 'request', id, command, payload });
      } catch (error) {
        this.#deps.pending.settle(
          id,
          err(appError(ErrorCode.INTERNAL, { detail: error instanceof Error ? error.message : String(error) }))
        );
      }
    });
  }

  readonly #readyWaiters = new Set<(outcome: ReadyOutcome | 'timeout') => void>();

  waitReady(timeoutMs: number, startIfIdle: () => void): Promise<ReadyOutcome | 'timeout'> {
    if (this.#phase === 'offline' || this.#phase === 'disposed') return Promise.resolve(this.#phase);
    if (this.#phase === 'idle') startIfIdle();
    return new Promise((resolve) => {
      const done = (outcome: ReadyOutcome | 'timeout'): void => {
        this.#readyWaiters.delete(done);
        cancel();
        resolve(outcome);
      };
      const cancel = this.#deps.client.timers.schedule(() => done('timeout'), timeoutMs);
      this.#readyWaiters.add(done);
    });
  }

  notifyReadyWaiters(outcome: ReadyOutcome): void {
    for (const waiter of [...this.#readyWaiters]) waiter(outcome);
  }

  /** True once `child` has exited; false when it is still alive after `exitTimeoutMs`. */
  waitExit(child: HostProcess): Promise<boolean> {
    const exited = this.#exits.get(child);
    if (!exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const cancel = this.#deps.client.timers.schedule(
        () => resolve(false),
        this.#deps.client.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS
      );
      void exited.then(() => {
        cancel();
        resolve(true);
      });
    });
  }

  crash(generation: number, error: AppErrorData): void {
    if (generation !== this.#generation || this.#phase === 'disposed' || this.#phase === 'offline') return;
    if (this.#suspended) {
      this.teardown(ErrorCode.HOST_RESTARTING);
      return;
    }
    this.teardown(this.#stopping ? ErrorCode.HOST_SHUTTING_DOWN : ErrorCode.HOST_UNAVAILABLE);
    if (this.#stopping) {
      this.notifyReadyWaiters('offline');
      return;
    }
    const decision = this.#deps.policy.recordCrash();
    if (decision.action === 'give-up') {
      this.#deps.client.logger.error('host keeps crashing; giving up', { attempts: decision.attempts });
      this.goOffline(error);
      return;
    }
    this.#phase = 'restarting';
    this.#deps.onStatus({ state: 'restarting', attempt: decision.attempt, error });
    this.#cancelStartup = this.#deps.client.timers.schedule(() => {
      this.#cancelStartup = null;
      if (this.#phase === 'restarting') this.spawn('restarting');
    }, decision.delayMs);
  }

  goOffline(error: AppErrorData): void {
    this.#phase = 'offline';
    this.#deps.onStatus({ state: 'offline', error });
    this.notifyReadyWaiters('offline');
  }

  teardown(code: AppErrorData['code']): void {
    this.#generation += 1;
    this.#cancelStartup?.();
    this.#cancelStartup = null;
    const child = this.#process;
    this.#process = null;
    if (child) {
      try {
        child.kill();
      } catch (error) {
        this.#deps.client.logger.warn('host kill failed', describeError(error));
      }
    }
    this.#deps.pending.failAll(code);
  }

  dispose(): void {
    this.#phase = 'disposed';
    this.teardown(ErrorCode.HOST_SHUTTING_DOWN);
    this.notifyReadyWaiters('disposed');
  }
}

export function unavailableError(phase: HostPhase, outcome: ReadyOutcome | 'timeout'): AppErrorData {
  if (outcome === 'disposed') return appError(ErrorCode.HOST_SHUTTING_DOWN);
  if (outcome === 'timeout') {
    return appError(phase === 'restarting' ? ErrorCode.HOST_RESTARTING : ErrorCode.HOST_TIMEOUT);
  }
  return appError(ErrorCode.HOST_UNAVAILABLE);
}
