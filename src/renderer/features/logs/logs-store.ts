/**
 * Log ring buffer (last 300 entries). Live `log` events are appended in batches;
 * opening the Logs panel replaces the buffer with the host's recent history.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { LogEntryDto } from '../../../shared/contracts/dto.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../shared/api/yami-client.ts';

export const MAX_LOG_ENTRIES = 300;

export interface LogsStoreState {
  readonly entries: readonly LogEntryDto[];
  readonly loading: boolean;
  readonly error: AppErrorData | null;
  append(entries: readonly LogEntryDto[]): void;
  loadRecent(): Promise<void>;
  clear(): void;
}

export type LogsStore = StoreApi<LogsStoreState>;

/** Appends and keeps only the newest `max` entries. */
export function appendRing<T>(current: readonly T[], incoming: readonly T[], max: number): readonly T[] {
  if (incoming.length === 0) return current;
  if (incoming.length >= max) return incoming.slice(incoming.length - max);
  const overflow = current.length + incoming.length - max;
  return overflow > 0 ? [...current.slice(overflow), ...incoming] : [...current, ...incoming];
}

export function createLogsStore(deps: { readonly request: HostRequest }): LogsStore {
  return createStore<LogsStoreState>()((set, get) => ({
    entries: [],
    loading: false,
    error: null,
    append(entries) {
      set({ entries: appendRing(get().entries, entries, MAX_LOG_ENTRIES) });
    },
    async loadRecent() {
      set({ loading: true, error: null });
      const result = await deps.request('logs.recent', {});
      if (result.ok) {
        // Keep entries that arrived after the host produced its snapshot.
        const lastTs = result.data.entries.at(-1)?.ts ?? 0;
        const newer = get().entries.filter((entry) => entry.ts > lastTs);
        set({ entries: appendRing(result.data.entries, newer, MAX_LOG_ENTRIES), loading: false });
      } else {
        set({ loading: false, error: result.error });
      }
    },
    clear() {
      set({ entries: [] });
    }
  }));
}
