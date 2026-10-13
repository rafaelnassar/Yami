/**
 * The conversation open in the workspace: detail (`conversations.get`) plus its
 * files, paginated (`conversations.files`). `files.added` events for the open
 * conversation are appended locally instead of refetching.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationDetailDto, MediaFileDto } from '../../../../shared/contracts/dto.ts';
import { ErrorCode, type AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../../shared/api/yami-client.ts';
import { createDebounced, type Scheduler } from '../../../shared/lib/scheduler.ts';

export const FILES_PAGE_SIZE = 300;
export const RELOAD_DEBOUNCE_MS = 300;

export interface ActiveConversationState {
  readonly id: string | null;
  readonly conversation: ConversationDetailDto | null;
  readonly files: readonly MediaFileDto[];
  readonly filesCursor: string | null;
  readonly loading: boolean;
  readonly loadingFiles: boolean;
  /** Failure of the detail request (`conversations.get`). */
  readonly error: AppErrorData | null;
  /** Failure of a files page; shown next to the grid with a retry. */
  readonly filesError: AppErrorData | null;
  /** Opens a conversation (`null` = home / new download). */
  open(id: string | null): void;
  reload(): Promise<void>;
  scheduleReload(): void;
  loadMoreFiles(): Promise<void>;
  /** Retries whatever files request failed (first page or the next page). */
  retryFiles(): Promise<void>;
  appendFiles(items: readonly MediaFileDto[]): void;
  removeFiles(paths: readonly string[]): void;
  patchTitle(title: string): void;
}

export type ActiveConversationStore = StoreApi<ActiveConversationState>;

/** Appends files not yet known (by path), preserving order. */
export function mergeFiles(
  current: readonly MediaFileDto[],
  incoming: readonly MediaFileDto[]
): readonly MediaFileDto[] {
  if (incoming.length === 0) return current;
  const known = new Set(current.map((file) => file.path));
  const added: MediaFileDto[] = [];
  for (const file of incoming) {
    if (known.has(file.path)) continue;
    known.add(file.path);
    added.push(file);
  }
  return added.length === 0 ? current : [...current, ...added];
}

export interface ActiveConversationDeps {
  readonly request: HostRequest;
  readonly scheduler: Scheduler;
  /** Called when the open conversation no longer exists (deleted elsewhere). */
  readonly onMissing?: (id: string) => void;
}

export function createActiveConversationStore(deps: ActiveConversationDeps): ActiveConversationStore {
  // Separate tokens: a debounced detail refresh (progress, events) must not
  // discard an in-flight first page of files, and vice versa.
  let detailToken = 0;
  let filesToken = 0;
  let moreToken = 0;

  return createStore<ActiveConversationState>()((set, get) => {
    const loadDetail = async (id: string): Promise<void> => {
      const token = ++detailToken;
      set({ loading: true });
      const detail = await deps.request('conversations.get', { conversationId: id });
      if (token !== detailToken || get().id !== id) return;
      if (!detail.ok) {
        set({ loading: false, error: detail.error, conversation: null });
        if (detail.error.code === ErrorCode.CONVERSATION_NOT_FOUND) deps.onMissing?.(id);
        return;
      }
      set({ conversation: detail.data.conversation, loading: false, error: null });
    };

    const loadFirstFiles = async (id: string): Promise<void> => {
      const token = ++filesToken;
      const files = await deps.request('conversations.files', { conversationId: id, limit: FILES_PAGE_SIZE });
      if (token !== filesToken || get().id !== id) return;
      if (!files.ok) {
        set({ filesError: files.error });
        return;
      }
      // Files appended by live events meanwhile are kept after the first page.
      set({
        files: mergeFiles(
          files.data.items,
          get().files.filter((file) => file.conversationId === id)
        ),
        filesCursor: files.data.nextCursor,
        filesError: null
      });
    };

    const load = async (withFiles: boolean): Promise<void> => {
      const id = get().id;
      if (!id) return;
      await Promise.all([loadDetail(id), withFiles ? loadFirstFiles(id) : Promise.resolve()]);
    };

    const debounced = createDebounced(deps.scheduler, () => void load(false), RELOAD_DEBOUNCE_MS);

    return {
      id: null,
      conversation: null,
      files: [],
      filesCursor: null,
      loading: false,
      loadingFiles: false,
      error: null,
      filesError: null,
      open(id) {
        if (id === get().id) return;
        detailToken += 1;
        filesToken += 1;
        moreToken += 1;
        debounced.cancel();
        set({
          id,
          conversation: null,
          files: [],
          filesCursor: null,
          error: null,
          filesError: null,
          loading: id !== null,
          loadingFiles: false
        });
        if (id) void load(true);
      },
      reload: () => load(true),
      scheduleReload() {
        if (get().id) debounced.trigger();
      },
      async retryFiles() {
        const { id, filesCursor } = get();
        if (!id) return;
        if (filesCursor) await get().loadMoreFiles();
        else await loadFirstFiles(id);
      },
      async loadMoreFiles() {
        const { id, filesCursor, loadingFiles } = get();
        if (!id || !filesCursor || loadingFiles) return;
        const token = ++moreToken;
        set({ loadingFiles: true, filesError: null });
        const result = await deps.request('conversations.files', {
          conversationId: id,
          limit: FILES_PAGE_SIZE,
          cursor: filesCursor
        });
        if (token !== moreToken || get().id !== id) return;
        if (!result.ok) {
          set({ loadingFiles: false, filesError: result.error });
          return;
        }
        set({
          files: mergeFiles(get().files, result.data.items),
          filesCursor: result.data.nextCursor,
          loadingFiles: false
        });
      },
      appendFiles(items) {
        const id = get().id;
        if (!id) return;
        const mine = items.filter((file) => file.conversationId === id);
        if (mine.length > 0) set({ files: mergeFiles(get().files, mine) });
      },
      removeFiles(paths) {
        const removed = new Set(paths);
        const files = get().files.filter((file) => !removed.has(file.path));
        if (files.length !== get().files.length) set({ files });
      },
      patchTitle(title) {
        const conversation = get().conversation;
        if (conversation) set({ conversation: { ...conversation, title } });
      }
    };
  });
}
