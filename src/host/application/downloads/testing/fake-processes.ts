/**
 * Fake OS processes: a launcher whose processes write scripted log lines and exit
 * on demand, plus an inspector/terminator over the same process table.
 */
import { appError, ErrorCode, type AppErrorData } from '../../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../../shared/kernel/result.ts';
import type { ProcessIdentity } from '../../../domain/processes/process-identity.ts';
import type {
  LaunchedProcess,
  LaunchSpec,
  ProcessExit,
  ProcessInspector,
  ProcessLauncher,
  ProcessTerminator
} from '../../ports/processes.ts';
import type { FakeLogStore } from './fake-logs.ts';

export function fakeIdentity(pid: number, executable = '/opt/bin/engine'): ProcessIdentity {
  return { pid, imageName: 'engine', startToken: `t${pid}`, startTokenSource: 'proc', executable, capturedAt: 0 };
}

export class FakeProcess implements LaunchedProcess {
  readonly identity: ProcessIdentity;
  readonly spec: LaunchSpec;
  readonly exited: Promise<ProcessExit>;
  alive = true;
  #resolve: (exit: ProcessExit) => void = () => undefined;
  readonly #logs: FakeLogStore;

  constructor(pid: number, spec: LaunchSpec, logs: FakeLogStore) {
    this.identity = fakeIdentity(pid, spec.executable);
    this.spec = spec;
    this.#logs = logs;
    this.exited = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** Appends engine output lines to the process log file. */
  write(...lines: readonly string[]): this {
    this.#logs.append(this.spec.logFile, lines);
    return this;
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    if (!this.alive) return;
    this.alive = false;
    this.#resolve({ code, signal });
  }
}

/** `hang`: termination waits until `releaseTerminations()` (a slow OS). */
export type TerminateBehavior = 'kill' | 'refuse' | 'throw' | 'hang';

export class FakeProcessHost implements ProcessLauncher, ProcessInspector, ProcessTerminator {
  readonly processes: FakeProcess[] = [];
  /** Processes of a previous host instance (re-attach), by pid → alive. */
  readonly external = new Map<number, boolean>();
  /** PIDs now used by an unrelated process: alive for non-strict checks, not ours for strict ones. */
  readonly reused = new Set<number>();
  readonly terminated: number[] = [];
  /** PIDs whose termination started (before it completed). */
  readonly terminating: number[] = [];
  strictChecks = 0;
  aliveManyCalls = 0;
  #hanging: (() => void)[] = [];
  launchError: AppErrorData | null = null;
  terminateBehavior: TerminateBehavior = 'kill';
  #nextPid = 1000;
  readonly #logs: FakeLogStore;

  constructor(logs: FakeLogStore) {
    this.#logs = logs;
  }

  async launch(spec: LaunchSpec): Promise<Result<LaunchedProcess, AppErrorData>> {
    if (this.launchError) return err(this.launchError);
    this.#logs.truncate(spec.logFile);
    const process = new FakeProcess(this.#nextPid++, spec, this.#logs);
    this.processes.push(process);
    return ok(process);
  }

  async isAlive(identity: ProcessIdentity, options: { readonly strict: boolean }): Promise<boolean> {
    if (options.strict) this.strictChecks += 1;
    if (this.reused.has(identity.pid)) return !options.strict;
    return this.#alive(identity.pid);
  }

  async aliveMany(identities: readonly ProcessIdentity[]): Promise<ReadonlyMap<number, boolean>> {
    this.aliveManyCalls += 1;
    return new Map(
      identities.map((identity) => [identity.pid, this.reused.has(identity.pid) || this.#alive(identity.pid)])
    );
  }

  async terminate(identity: ProcessIdentity): Promise<boolean> {
    this.terminating.push(identity.pid);
    if (this.terminateBehavior === 'hang') {
      await new Promise<void>((resolve) => this.#hanging.push(resolve));
      return this.#kill(identity);
    }
    if (this.terminateBehavior === 'throw') throw new Error('taskkill failed');
    return this.#kill(identity);
  }

  /** Completes every hanging termination. */
  releaseTerminations(): void {
    const hanging = this.#hanging;
    this.#hanging = [];
    for (const resolve of hanging) resolve();
  }

  #kill(identity: ProcessIdentity): boolean {
    if (this.terminateBehavior === 'refuse' || this.reused.has(identity.pid)) return false;
    this.terminated.push(identity.pid);
    const process = this.byPid(identity.pid);
    if (process) process.exit(null, 'SIGTERM');
    if (this.external.has(identity.pid)) this.external.set(identity.pid, false);
    return true;
  }

  last(): FakeProcess {
    const process = this.processes.at(-1);
    if (!process) throw new Error('no process launched');
    return process;
  }

  byPid(pid: number): FakeProcess | undefined {
    return this.processes.find((process) => process.identity.pid === pid);
  }

  running(): FakeProcess[] {
    return this.processes.filter((process) => process.alive);
  }

  #alive(pid: number): boolean {
    return this.byPid(pid)?.alive ?? this.external.get(pid) ?? false;
  }
}

export const LAUNCH_FAILED = appError(ErrorCode.INTERNAL, { detail: 'spawn ENOENT' });
