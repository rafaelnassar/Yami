/**
 * Toast stack: host notices (`notice` / `notice.dismissed` events) plus local
 * feedback from renderer actions. Texts are stored as structured specs (i18n
 * keys, error codes, outcomes) and translated when rendered.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DownloadOutcomeDto, NoticeActionDto, NoticeDto, NoticeKind } from '../../../shared/contracts/dto.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import type { TranslateParams } from '../../../shared/i18n/translator.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { DURATION } from '../../shared/lib/motion.ts';

export type ToastText =
  | { readonly kind: 'key'; readonly key: MessageKey; readonly params?: TranslateParams }
  | { readonly kind: 'error'; readonly error: AppErrorData }
  | { readonly kind: 'outcome'; readonly outcome: DownloadOutcomeDto }
  | { readonly kind: 'raw'; readonly text: string };

/** `vault-reset`: asks main to reset a disabled vault (`YamiApi.vault.reset`). */
export type ToastAction = NoticeActionDto | { readonly type: 'open-settings' } | { readonly type: 'vault-reset' };

export interface Toast {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly ts: number;
  readonly origin: 'host' | 'local';
  /** Host notices are translated from `notices.<code>.*`. */
  readonly notice: NoticeDto | null;
  readonly title: ToastText | null;
  readonly message: ToastText | null;
  readonly action: ToastAction | null;
  /** Sticky toasts stay until dismissed. */
  readonly sticky: boolean;
  /** Once dismissed by the user, pushes with the same id are ignored for the rest of the session. */
  readonly rememberDismissal: boolean;
}

export interface LocalToast {
  readonly kind: NoticeKind;
  readonly title: ToastText;
  readonly message?: ToastText | null;
  /** Stable id: a toast with the same id replaces the previous one. */
  readonly id?: string;
  readonly action?: ToastAction | null;
  readonly sticky?: boolean;
  /** Requires `id`: after the user dismisses it, it does not come back this session. */
  readonly rememberDismissal?: boolean;
}

export const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 2_500;

export interface NoticesStoreState {
  readonly toasts: readonly Toast[];
  push(toast: LocalToast): string;
  receiveNotice(notice: NoticeDto): void;
  /**
   * Mirrors `HostStateDto.lastError` (on init and every state), so an error
   * emitted before this window subscribed is still shown. Upserts by id, never
   * re-adds an error the user dismissed, and drops the toast once the host
   * clears it (e.g. dismissed in another window).
   */
  syncHostError(notice: NoticeDto | null): void;
  /** User dismissal (clears the host's `lastError` for host error notices). */
  dismiss(id: string): void;
  /** Removal requested by the host (`notice.dismissed`); no side effects. */
  remove(id: string): void;
  clear(): void;
}

export type NoticesStore = StoreApi<NoticesStoreState>;

export interface NoticesStoreDeps {
  readonly now: () => number;
  /** Called when the user dismisses a host error notice (clears `state.lastError`). */
  readonly clearHostError?: () => void;
}

export const key = (messageKey: MessageKey, params?: TranslateParams): ToastText =>
  params ? { kind: 'key', key: messageKey, params } : { kind: 'key', key: messageKey };

export const errorText = (error: AppErrorData): ToastText => ({ kind: 'error', error });

function textIdentity(text: ToastText | null): string {
  if (!text) return '';
  switch (text.kind) {
    case 'key':
      return `k:${text.key}`;
    case 'error':
      return `e:${text.error.code}`;
    case 'outcome':
      return `o:${text.outcome.kind}:${text.outcome.reason ?? ''}`;
    case 'raw':
      return `r:${text.text}`;
  }
}

/** Exact content equality (texts are small plain objects). */
function sameContent(toast: Toast, input: LocalToast): boolean {
  const json = (value: unknown): string => JSON.stringify(value ?? null);
  return (
    toast.kind === input.kind &&
    json(toast.title) === json(input.title) &&
    json(toast.message) === json(input.message) &&
    json(toast.action) === json(input.action)
  );
}

function upsert(toasts: readonly Toast[], toast: Toast, dedupe: (item: Toast) => boolean): Toast[] {
  const index = toasts.findIndex((item) => item.id === toast.id || dedupe(item));
  if (index < 0) return [...toasts, toast].slice(-MAX_TOASTS);
  const next = [...toasts];
  next[index] = { ...toast, id: toasts[index]?.id ?? toast.id };
  return next;
}

/** Identity of one occurrence of a host notice (ids are reused for recurring errors). */
const occurrence = (notice: Pick<NoticeDto, 'id' | 'ts'>): string => `${notice.id}\u0000${notice.ts}`;

export function createNoticesStore(deps: NoticesStoreDeps): NoticesStore {
  let seq = 0;
  let syncedHostError: NoticeDto | null = null;
  const dismissedHostErrors = new Set<string>();
  const dismissedLocalIds = new Set<string>();
  const hostToast = (notice: NoticeDto): Toast => ({
    id: notice.id,
    kind: notice.kind,
    ts: notice.ts,
    origin: 'host',
    notice,
    title: null,
    message: null,
    action: notice.action,
    sticky: notice.action !== null || notice.kind === 'error' || notice.kind === 'warn',
    rememberDismissal: false
  });
  return createStore<NoticesStoreState>()((set, get) => ({
    toasts: [],
    push(input) {
      if (input.id !== undefined && dismissedLocalIds.has(input.id)) return input.id;
      const current = input.id === undefined ? undefined : get().toasts.find((item) => item.id === input.id);
      // Same id and same content: nothing to update (avoids resetting timers/animations).
      if (current && current.origin === 'local' && sameContent(current, input)) return current.id;
      const ts = deps.now();
      const id = input.id ?? `local-${ts}-${++seq}`;
      const toast: Toast = {
        id,
        kind: input.kind,
        ts,
        origin: 'local',
        notice: null,
        title: input.title,
        message: input.message ?? null,
        action: input.action ?? null,
        sticky: input.sticky ?? (Boolean(input.action) || input.kind === 'error' || input.kind === 'warn'),
        rememberDismissal: input.id !== undefined && input.rememberDismissal === true
      };
      const identity = textIdentity(input.title);
      const duplicate = (item: Toast): boolean =>
        item.origin === 'local' &&
        item.kind === toast.kind &&
        textIdentity(item.title) === identity &&
        Math.abs(item.ts - ts) < DEDUPE_WINDOW_MS;
      const existing = get().toasts.find((item) => item.id === id || duplicate(item));
      set({ toasts: upsert(get().toasts, toast, duplicate) });
      return existing?.id ?? id;
    },
    receiveNotice(notice) {
      set({ toasts: upsert(get().toasts, hostToast(notice), () => false) });
    },
    syncHostError(notice) {
      const previousId = syncedHostError?.id ?? null;
      syncedHostError = notice;
      if (!notice) {
        if (previousId && get().toasts.some((item) => item.id === previousId && item.origin === 'host')) {
          set({ toasts: get().toasts.filter((item) => !(item.id === previousId && item.origin === 'host')) });
        }
        return;
      }
      if (dismissedHostErrors.has(occurrence(notice))) return;
      // State snapshots arrive up to 4×/s: skip the update when nothing changed.
      const existing = get().toasts.find((item) => item.id === notice.id);
      if (existing?.origin === 'host' && existing.ts === notice.ts) return;
      set({ toasts: upsert(get().toasts, hostToast(notice), () => false) });
    },
    dismiss(id) {
      const target = get().toasts.find((item) => item.id === id);
      if (!target) return;
      set({ toasts: get().toasts.filter((item) => item.id !== id) });
      if (target.rememberDismissal) dismissedLocalIds.add(id);
      const synced = syncedHostError?.id === id ? syncedHostError : null;
      if (target.origin === 'host' && (target.kind === 'error' || synced)) {
        // Snapshots taken before the host processed `notices.clearError` still carry it
        // (possibly with the timestamp of the snapshot rather than of the event).
        dismissedHostErrors.add(occurrence(target));
        if (synced) dismissedHostErrors.add(occurrence(synced));
        deps.clearHostError?.();
      }
    },
    remove(id) {
      set({ toasts: get().toasts.filter((item) => item.id !== id) });
    },
    clear() {
      set({ toasts: [] });
    }
  }));
}

/** Auto-dismiss delay in ms, or `null` for sticky toasts. */
export function autoDismissMs(toast: Pick<Toast, 'sticky' | 'kind'>): number | null {
  if (toast.sticky) return null;
  return toast.kind === 'success' ? DURATION.toastSuccessMs : DURATION.toastMs;
}
