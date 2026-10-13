/**
 * Composer (new download) UI state. Kept in memory only: drafts are session
 * state, while engine/scope preferences are app settings (main).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DownloadScope } from '../../../../shared/domain/engine.ts';

export interface ComposerState {
  readonly mode: DownloadScope;
  readonly urlDraft: string;
  readonly batchDraft: string;
  /** Sidebar folder that will receive the next started download(s). */
  readonly pendingFolderId: string | null;
  /** Bumped by "New download" so the greeting changes and the input is refocused. */
  readonly promptRevision: number;
  /** Number of `downloads.start` requests in flight. */
  readonly starting: number;
  readonly setMode: (mode: DownloadScope) => void;
  readonly setUrlDraft: (value: string) => void;
  readonly setBatchDraft: (value: string) => void;
  readonly setPendingFolder: (folderId: string | null) => void;
  readonly newPrompt: (folderId: string | null) => void;
  readonly beginStart: () => void;
  /** `mode` is the scope that was submitted (the user may have switched modes meanwhile). */
  readonly endStart: (succeeded: boolean, mode: DownloadScope) => void;
}

export type ComposerStore = StoreApi<ComposerState>;

export function createComposerStore(): ComposerStore {
  return createStore<ComposerState>()((set, get) => ({
    mode: 'single',
    urlDraft: '',
    batchDraft: '',
    pendingFolderId: null,
    promptRevision: 0,
    starting: 0,
    setMode: (mode) => set({ mode }),
    setUrlDraft: (urlDraft) => set({ urlDraft }),
    setBatchDraft: (batchDraft) => set({ batchDraft }),
    setPendingFolder: (pendingFolderId) => set({ pendingFolderId }),
    newPrompt: (folderId) => set({ promptRevision: get().promptRevision + 1, pendingFolderId: folderId }),
    beginStart: () => set({ starting: get().starting + 1 }),
    endStart(succeeded, mode) {
      const starting = Math.max(0, get().starting - 1);
      if (!succeeded) {
        set({ starting });
        return;
      }
      const draftPatch = mode === 'single' ? { urlDraft: '' } : { batchDraft: '' };
      set({ starting, pendingFolderId: null, ...draftPatch });
    }
  }));
}
