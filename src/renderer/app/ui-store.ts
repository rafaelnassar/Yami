/**
 * Shell UI state (memory only): sidebar, top-level panels and the single active
 * confirmation/edit dialog.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationSummaryDto, FolderDto } from '../../shared/contracts/dto.ts';
import type { MessageKey } from '../../shared/i18n/catalog.ts';

export type AppDialog =
  | { readonly kind: 'rename-conversation'; readonly conversationId: string; readonly title: string }
  | { readonly kind: 'stop-conversation'; readonly conversationId: string; readonly title: string }
  | { readonly kind: 'delete-conversation'; readonly conversation: ConversationSummaryDto }
  | {
      readonly kind: 'delete-files';
      readonly title: MessageKey;
      readonly label: string;
      readonly paths: readonly string[];
    }
  | { readonly kind: 'edit-folder'; readonly folder: FolderDto | null }
  | { readonly kind: 'delete-folder'; readonly folder: FolderDto };

export type Panel = 'settings' | 'logs';

export interface UiState {
  readonly sidebarOpen: boolean;
  readonly panels: Readonly<Record<Panel, boolean>>;
  readonly dialog: AppDialog | null;
  /** "Not now" in the setup wizard (session only; the host persists its own dismissal). */
  readonly setupDismissed: boolean;
  setSidebarOpen(open: boolean): void;
  openPanel(panel: Panel): void;
  closePanel(panel: Panel): void;
  openDialog(dialog: AppDialog): void;
  closeDialog(): void;
  dismissSetup(): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set, get) => ({
    sidebarOpen: true,
    panels: { settings: false, logs: false },
    dialog: null,
    setupDismissed: false,
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    openPanel: (panel) => set({ panels: { ...get().panels, [panel]: true } }),
    closePanel: (panel) => set({ panels: { ...get().panels, [panel]: false } }),
    openDialog: (dialog) => set({ dialog }),
    closeDialog: () => set({ dialog: null }),
    dismissSetup: () => set({ setupDismissed: true })
  }));
}
