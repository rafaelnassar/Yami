/**
 * Public and internal types for `HostClient`.
 */
import type { CommandPayload } from '../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../shared/kernel/errors.ts';
import type { Result } from '../../shared/kernel/result.ts';
import type { Logger } from '../infrastructure/logger.ts';
import type { Timers } from '../infrastructure/timers.ts';
import type { HostProcessFactory } from './host-process.ts';

export type ConfigurePayload = CommandPayload<'system.configure'>;

export interface HostClientDeps {
  readonly spawn: HostProcessFactory;
  /** Builds the `system.configure` payload (paths, vault key…); re-run on every (re)start. */
  readonly configure: () => Promise<Result<ConfigurePayload, AppErrorData>>;
  readonly timers: Timers;
  readonly now: () => number;
  readonly logger: Logger;
  readonly readyTimeoutMs?: number;
  readonly restartDelaysMs?: readonly number[];
  /** How long `restartWith()` waits for the stopped host process to exit (default 5 s). */
  readonly exitTimeoutMs?: number;
}

export const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

export type HostPhase = 'idle' | 'starting' | 'ready' | 'restarting' | 'offline' | 'disposed';
export type ReadyOutcome = 'ready' | 'offline' | 'disposed';
