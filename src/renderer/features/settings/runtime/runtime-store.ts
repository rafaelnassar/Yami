/**
 * Background runtime-tool operations (install / update / check). Commands return
 * an `operationId` immediately; progress arrives as `runtime.progress` events and
 * completion as `runtime.operationFinished`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { RuntimeOperationKind, RuntimeProgressDto } from '../../../../shared/contracts/dto.ts';
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { Scheduler } from '../../../shared/lib/scheduler.ts';

export interface FinishedOperation {
  readonly operationId: string;
  readonly ok: boolean;
  readonly error: AppErrorData | null;
  /** Kind when the operation was started from this window. */
  readonly kind: RuntimeOperationKind | null;
}

export interface RuntimeStoreState {
  readonly progress: RuntimeProgressDto | null;
  readonly lastFinished: FinishedOperation | null;
  /** Operations started by this window (to toast their result once). */
  readonly started: Readonly<Record<string, RuntimeOperationKind>>;
  track(operationId: string, kind: RuntimeOperationKind): void;
  receiveProgress(progress: RuntimeProgressDto): void;
  /** Returns the finished record (with `kind` when started here). */
  receiveFinished(operationId: string, ok: boolean, error: AppErrorData | null): FinishedOperation;
}

export type RuntimeStore = StoreApi<RuntimeStoreState>;

/** Successful progress boxes linger briefly so users see "done". */
export const PROGRESS_CLEAR_MS = 2_500;

export function createRuntimeStore(deps: { readonly scheduler: Scheduler }): RuntimeStore {
  let cancelClear: (() => void) | null = null;
  return createStore<RuntimeStoreState>()((set, get) => ({
    progress: null,
    lastFinished: null,
    started: {},
    track(operationId, kind) {
      set({ started: { ...get().started, [operationId]: kind } });
    },
    receiveProgress(progress) {
      cancelClear?.();
      cancelClear = null;
      set({ progress });
    },
    receiveFinished(operationId, ok, error) {
      const { [operationId]: kind, ...rest } = get().started;
      const finished: FinishedOperation = { operationId, ok, error, kind: kind ?? null };
      set({ lastFinished: finished, started: rest });
      if (ok) {
        cancelClear?.();
        cancelClear = deps.scheduler.delay(() => {
          cancelClear = null;
          if (get().progress?.operationId === operationId) set({ progress: null });
        }, PROGRESS_CLEAR_MS);
      }
      return finished;
    }
  }));
}
