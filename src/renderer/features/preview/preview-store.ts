/** Media preview target (+ browse scope) and the remembered player volume. */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { MediaFileDto } from '../../../shared/contracts/dto.ts';
import type { MediaType } from '../../../shared/domain/media.ts';

/** Minimal file reference for conversation media preview. */
export interface MediaRef {
  readonly path: string;
  readonly name: string;
  readonly mediaType: MediaType;
  readonly sizeBytes: number | null;
  readonly ts: number;
  /** Extra adult-content hints (source URL, collection name) besides the path. */
  readonly blurHints?: readonly string[];
}

export function refFromMediaFile(file: MediaFileDto, blurHints?: readonly string[]): MediaRef {
  return {
    path: file.path,
    name: file.name,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    ts: file.createdAt,
    ...(blurHints ? { blurHints } : {})
  };
}

export function isPreviewable(mediaType: MediaType): boolean {
  return mediaType === 'image' || mediaType === 'video' || mediaType === 'audio';
}

export interface PreviewState {
  readonly current: MediaRef | null;
  readonly scope: readonly MediaRef[];
  /** Last non-zero volume chosen by the user (restored when unmuting). */
  readonly volume: number;
  open(file: MediaRef, scope?: readonly MediaRef[]): void;
  navigate(file: MediaRef): void;
  close(): void;
  rememberVolume(volume: number): void;
  removePaths(paths: readonly string[]): void;
}

export type PreviewStore = StoreApi<PreviewState>;

/** Images browse among images, videos among videos (arrow keys / chevrons). */
export function browseList(
  scope: readonly MediaRef[],
  current: MediaRef | null
): { readonly items: readonly MediaRef[]; readonly index: number } {
  if (!current || (current.mediaType !== 'image' && current.mediaType !== 'video')) return { items: [], index: -1 };
  const items = scope.filter((item) => item.mediaType === current.mediaType);
  return { items, index: items.findIndex((item) => item.path === current.path) };
}

export function siblingOf(scope: readonly MediaRef[], current: MediaRef | null, direction: 1 | -1): MediaRef | null {
  const { items, index } = browseList(scope, current);
  if (index < 0 || items.length < 2) return null;
  return items[(index + direction + items.length) % items.length] ?? null;
}

export function createPreviewStore(): PreviewStore {
  return createStore<PreviewState>()((set, get) => ({
    current: null,
    scope: [],
    volume: 1,
    open: (file, scope) => set({ current: file, scope: scope && scope.length > 0 ? scope : [file] }),
    navigate: (file) => set({ current: file }),
    close: () => set({ current: null, scope: [] }),
    rememberVolume(volume) {
      if (volume > 0) set({ volume });
    },
    removePaths(paths) {
      const removed = new Set(paths);
      const scope = get().scope.filter((item) => !removed.has(item.path));
      const current = get().current;
      set({ scope, current: current && removed.has(current.path) ? null : current });
    }
  }));
}
