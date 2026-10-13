/**
 * Conversation history (sidebar). Paginated `conversations.list`; refreshes are
 * debounced (bursts of `conversation.changed`) and single-flight. Existing rows
 * keep their position on refresh so the list does not jump while downloads run.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationSummaryDto } from '../../../../shared/contracts/dto.ts';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../../shared/api/yami-client.ts';
import { createDebounced, type Scheduler } from '../../../shared/lib/scheduler.ts';

export const CONVERSATIONS_PAGE_SIZE = 200;
export const REFRESH_DEBOUNCE_MS = 250;
/** A refresh already in flight when a row is deleted may still list it; ignore it for this long. */
export const DELETED_MEMORY_MS = 30_000;

export interface ConversationsStoreState {
  readonly items: readonly ConversationSummaryDto[];
  readonly nextCursor: string | null;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: AppErrorData | null;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** Debounced refresh; no-op until the list was loaded once. */
  scheduleRefresh(): void;
  /** Local removal (deleted); the id is ignored by in-flight/next refreshes for a short while. */
  remove(id: string): void;
  patch(ids: readonly string[], patch: Partial<Pick<ConversationSummaryDto, 'title' | 'folderId' | 'status'>>): void;
}

export type ConversationsStore = StoreApi<ConversationsStoreState>;

function sameSummary(a: ConversationSummaryDto, b: ConversationSummaryDto): boolean {
  return (
    a.title === b.title &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt &&
    a.folderId === b.folderId &&
    a.coverPath === b.coverPath &&
    a.totalBytes === b.totalBytes &&
    a.counters.done === b.counters.done &&
    a.counters.skipped === b.counters.skipped &&
    a.counters.errors === b.counters.errors &&
    a.outcome?.kind === b.outcome?.kind
  );
}

/**
 * New rows go on top (in incoming order); existing rows keep their place and
 * object identity when unchanged. Rows missing from `incoming` are dropped
 * unless they lie beyond the refreshed window (`keepMissing`).
 */
export function mergeSummaries(
  previous: readonly ConversationSummaryDto[],
  incoming: readonly ConversationSummaryDto[],
  keepMissing = false
): readonly ConversationSummaryDto[] {
  if (previous.length === 0) return incoming;
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const previousIds = new Set(previous.map((item) => item.id));
  const next: ConversationSummaryDto[] = incoming.filter((item) => !previousIds.has(item.id));
  for (const item of previous) {
    const updated = incomingById.get(item.id);
    if (updated) next.push(sameSummary(item, updated) ? item : updated);
    else if (keepMissing) next.push(item);
  }
  const unchanged = next.length === previous.length && next.every((item, index) => item === previous[index]);
  return unchanged ? previous : next;
}

export function createConversationsStore(deps: {
  readonly request: HostRequest;
  readonly scheduler: Scheduler;
}): ConversationsStore {
  let inFlight: Promise<void> | null = null;
  let again = false;
  const deletedAt = new Map<string, number>();

  const withoutDeleted = (items: readonly ConversationSummaryDto[]): readonly ConversationSummaryDto[] => {
    const now = deps.scheduler.now();
    for (const [id, at] of deletedAt) if (now - at > DELETED_MEMORY_MS) deletedAt.delete(id);
    return deletedAt.size === 0 ? items : items.filter((item) => !deletedAt.has(item.id));
  };

  return createStore<ConversationsStoreState>()((set, get) => {
    const fetchFirstPages = async (): Promise<void> => {
      const previous = get().items;
      const limit = Math.min(LIMITS.maxPageSize, Math.max(CONVERSATIONS_PAGE_SIZE, previous.length));
      set({ loading: true });
      const result = await deps.request('conversations.list', { limit });
      if (!result.ok) {
        set({ loading: false, error: result.error });
        return;
      }
      const beyondWindow = previous.length > limit;
      set({
        items: mergeSummaries(get().items, withoutDeleted(result.data.items), beyondWindow),
        nextCursor: beyondWindow ? get().nextCursor : result.data.nextCursor,
        loaded: true,
        loading: false,
        error: null
      });
    };

    const refresh = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return inFlight;
      }
      inFlight = (async () => {
        do {
          again = false;
          await fetchFirstPages();
        } while (again);
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    const debounced = createDebounced(deps.scheduler, () => void refresh(), REFRESH_DEBOUNCE_MS);

    return {
      items: [],
      nextCursor: null,
      loaded: false,
      loading: false,
      loadingMore: false,
      error: null,
      refresh,
      async loadMore() {
        const cursor = get().nextCursor;
        if (!cursor || get().loadingMore) return;
        set({ loadingMore: true });
        const result = await deps.request('conversations.list', { limit: CONVERSATIONS_PAGE_SIZE, cursor });
        if (!result.ok) {
          set({ loadingMore: false, error: result.error });
          return;
        }
        const known = new Set(get().items.map((item) => item.id));
        set({
          items: [...get().items, ...withoutDeleted(result.data.items).filter((item) => !known.has(item.id))],
          nextCursor: result.data.nextCursor,
          loadingMore: false
        });
      },
      scheduleRefresh() {
        if (get().loaded || get().loading) debounced.trigger();
      },
      remove(id) {
        deletedAt.set(id, deps.scheduler.now());
        const items = get().items.filter((item) => item.id !== id);
        if (items.length !== get().items.length) set({ items });
      },
      patch(ids, patch) {
        const targets = new Set(ids);
        set({ items: get().items.map((item) => (targets.has(item.id) ? { ...item, ...patch } : item)) });
      }
    };
  });
}
