/**
 * Cookie files, default selection, site bindings and the browser-cookies flag.
 * All of it lives in the host (encrypted vault); every mutation returns the new
 * snapshot and `cookies.changed` keeps other windows in sync.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CookieBindingDto } from '../../../../shared/contracts/dto.ts';
import type { CookiesSnapshot } from '../../../../shared/contracts/host-protocol.ts';
import type { IpcResult } from '../../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../../shared/api/yami-client.ts';

export interface CookiesStoreState {
  readonly snapshot: CookiesSnapshot | null;
  readonly loading: boolean;
  readonly error: AppErrorData | null;
  receive(snapshot: CookiesSnapshot): void;
  load(): Promise<void>;
  upload(name: string, content: string): Promise<AppErrorData | null>;
  select(name: string | null): Promise<AppErrorData | null>;
  remove(name: string): Promise<AppErrorData | null>;
  setBindings(bindings: readonly CookieBindingDto[]): Promise<AppErrorData | null>;
  setFromBrowser(enabled: boolean): Promise<AppErrorData | null>;
}

export type CookiesStore = StoreApi<CookiesStoreState>;

export function createCookiesStore(deps: { readonly request: HostRequest }): CookiesStore {
  return createStore<CookiesStoreState>()((set) => {
    const apply = (result: IpcResult<CookiesSnapshot>): AppErrorData | null => {
      if (!result.ok) return result.error;
      set({ snapshot: result.data, error: null });
      return null;
    };

    return {
      snapshot: null,
      loading: false,
      error: null,
      receive(snapshot) {
        set({ snapshot });
      },
      async load() {
        set({ loading: true });
        const result = await deps.request('cookies.list', {});
        set(
          result.ok ? { snapshot: result.data, loading: false, error: null } : { loading: false, error: result.error }
        );
      },
      upload: async (name, content) => apply(await deps.request('cookies.upload', { name, content })),
      select: async (name) => apply(await deps.request('cookies.select', { name })),
      remove: async (name) => apply(await deps.request('cookies.delete', { name })),
      setBindings: async (bindings) =>
        apply(
          await deps.request('cookies.setBindings', {
            bindings: bindings.map((binding) => ({
              id: binding.id,
              siteHost: binding.siteHost,
              cookieName: binding.cookieName
            }))
          })
        ),
      setFromBrowser: async (enabled) => apply(await deps.request('cookies.setFromBrowser', { enabled }))
    };
  });
}
