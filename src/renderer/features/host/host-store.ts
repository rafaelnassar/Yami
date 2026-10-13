/**
 * Host connection + state snapshot. `state` events can arrive several times per
 * second while yt-dlp reports progress; they are coalesced so React commits at
 * most once per animation frame.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { HostStateDto } from '../../../shared/contracts/dto.ts';
import type { HostConnectionStatus } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../shared/api/yami-client.ts';
import type { Cancel, Scheduler } from '../../shared/lib/scheduler.ts';

export interface HostStoreState {
  readonly connection: HostConnectionStatus;
  readonly state: HostStateDto | null;
  /** Error of the last `session.init` attempt (cleared on success). */
  readonly initError: AppErrorData | null;
  /** A `session.init` request is in flight. */
  readonly initializing: boolean;
  readonly restarting: boolean;
  setConnection(status: HostConnectionStatus): void;
  /** Buffers a `state` event; applied on the next frame. */
  receiveState(state: HostStateDto): void;
  /**
   * Fetches the snapshot (`session.init`). Failures are retried automatically
   * with backoff while the host connection is up (see `INIT_RETRY_DELAYS_MS`).
   */
  init(): Promise<void>;
  /** Asks main to restart the host process (manual reconnect). */
  restart(): Promise<AppErrorData | null>;
}

export type HostStore = StoreApi<HostStoreState>;

export interface HostStoreDeps {
  readonly request: HostRequest;
  readonly restartHost: () => Promise<AppErrorData | null>;
  readonly scheduler: Scheduler;
}

/** Backoff between failed `session.init` attempts; the last delay repeats. */
export const INIT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];

export function initRetryDelay(failures: number): number {
  const index = Math.min(Math.max(failures, 1), INIT_RETRY_DELAYS_MS.length) - 1;
  return INIT_RETRY_DELAYS_MS[index] ?? 10_000;
}

export function createHostStore(deps: HostStoreDeps): HostStore {
  let pending: HostStateDto | null = null;
  let cancelFrame: Cancel | null = null;
  let cancelRetry: Cancel | null = null;
  let failures = 0;
  let initToken = 0;

  return createStore<HostStoreState>()((set, get) => {
    const flush = (): void => {
      cancelFrame = null;
      if (!pending) return;
      const next = pending;
      pending = null;
      set({ state: next });
    };

    const stopRetry = (): void => {
      cancelRetry?.();
      cancelRetry = null;
    };

    const init = async (): Promise<void> => {
      stopRetry();
      const token = ++initToken;
      set({ initializing: true });
      const result = await deps.request('session.init', {});
      if (token !== initToken) return;
      if (result.ok) {
        failures = 0;
        // A snapshot fetched on demand wins over any buffered (older) event.
        pending = null;
        cancelFrame?.();
        cancelFrame = null;
        set({ state: result.data.state, initError: null, initializing: false });
        return;
      }
      failures += 1;
      set({ initError: result.error, initializing: false });
      // While the host is down, the next `ready` transition triggers init() again.
      const connection = get().connection.state;
      if (connection === 'offline' || connection === 'restarting') return;
      cancelRetry = deps.scheduler.delay(() => {
        cancelRetry = null;
        void init();
      }, initRetryDelay(failures));
    };

    return {
      connection: { state: 'starting' },
      state: null,
      initError: null,
      initializing: false,
      restarting: false,
      setConnection(status) {
        if (status.state === 'offline' || status.state === 'restarting') stopRetry();
        // A fresh host process starts a fresh backoff sequence.
        if (status.state === 'ready' && get().connection.state !== 'ready') failures = 0;
        set({ connection: status });
      },
      receiveState(state) {
        pending = state;
        cancelFrame ??= deps.scheduler.frame(flush);
      },
      init,
      async restart() {
        set({ restarting: true });
        const error = await deps.restartHost();
        set({ restarting: false });
        return error;
      }
    };
  });
}

/** True when commands can be sent and a snapshot is available. */
export function isHostReady(state: Pick<HostStoreState, 'connection' | 'state'>): boolean {
  return state.connection.state === 'ready' && state.state !== null;
}
