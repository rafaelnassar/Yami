/** App auto-update status mirrored from main (`window.yami.updates`). */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { IpcResult, UpdateStatus } from '../../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';

export interface UpdatesStoreState {
  readonly status: UpdateStatus;
  readonly busy: boolean;
  receive(status: UpdateStatus): void;
  load(): Promise<void>;
  check(): Promise<AppErrorData | null>;
  install(): Promise<AppErrorData | null>;
}

export type UpdatesStore = StoreApi<UpdatesStoreState>;

export interface UpdatesStoreDeps {
  readonly getStatus: () => Promise<IpcResult<UpdateStatus>>;
  readonly check: () => Promise<IpcResult<UpdateStatus>>;
  readonly install: () => Promise<IpcResult<null>>;
}

export function createUpdatesStore(deps: UpdatesStoreDeps): UpdatesStore {
  return createStore<UpdatesStoreState>()((set) => ({
    status: { state: 'idle', checkedAt: null },
    busy: false,
    receive(status) {
      set({ status });
    },
    async load() {
      const result = await deps.getStatus();
      if (result.ok) set({ status: result.data });
    },
    async check() {
      set({ busy: true });
      const result = await deps.check();
      set(result.ok ? { status: result.data, busy: false } : { busy: false });
      return result.ok ? null : result.error;
    },
    async install() {
      set({ busy: true });
      const result = await deps.install();
      set({ busy: false });
      return result.ok ? null : result.error;
    }
  }));
}
