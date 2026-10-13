/**
 * Sidebar folders. They live in the host (`folders.*`), so both windows and
 * app restarts see the same organization. Collapse toggles are optimistic.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FolderDto } from '../../../../shared/contracts/dto.ts';
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../../shared/api/yami-client.ts';

export interface FolderPatch {
  readonly name?: string;
  readonly color?: string;
  readonly collapsed?: boolean;
}

export interface FoldersStoreState {
  readonly folders: readonly FolderDto[];
  readonly loaded: boolean;
  readonly error: AppErrorData | null;
  load(): Promise<void>;
  create(
    name: string,
    color: string
  ): Promise<{ readonly folder: FolderDto | null; readonly error: AppErrorData | null }>;
  update(folderId: string, patch: FolderPatch): Promise<AppErrorData | null>;
  remove(folderId: string): Promise<AppErrorData | null>;
}

export type FoldersStore = StoreApi<FoldersStoreState>;

export function sortFolders(folders: readonly FolderDto[]): readonly FolderDto[] {
  return [...folders].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

function replaceFolder(folders: readonly FolderDto[], folder: FolderDto): readonly FolderDto[] {
  return sortFolders(folders.map((item) => (item.id === folder.id ? folder : item)));
}

export function createFoldersStore(deps: { readonly request: HostRequest }): FoldersStore {
  return createStore<FoldersStoreState>()((set, get) => ({
    folders: [],
    loaded: false,
    error: null,
    async load() {
      const result = await deps.request('folders.list', {});
      if (result.ok) set({ folders: sortFolders(result.data.folders), loaded: true, error: null });
      else set({ error: result.error });
    },
    async create(name, color) {
      const result = await deps.request('folders.create', { name, color });
      if (!result.ok) return { folder: null, error: result.error };
      const folder = result.data.folder;
      set({ folders: sortFolders([...get().folders.filter((item) => item.id !== folder.id), folder]) });
      return { folder, error: null };
    },
    async update(folderId, patch) {
      const previous = get().folders;
      const current = previous.find((item) => item.id === folderId);
      if (current) set({ folders: replaceFolder(previous, { ...current, ...patch }) });
      const result = await deps.request('folders.update', { folderId, ...patch });
      if (result.ok) {
        set({ folders: replaceFolder(get().folders, result.data.folder) });
        return null;
      }
      set({ folders: previous });
      return result.error;
    },
    async remove(folderId) {
      const result = await deps.request('folders.delete', { folderId });
      if (!result.ok) return result.error;
      set({ folders: get().folders.filter((item) => item.id !== folderId) });
      return null;
    }
  }));
}
