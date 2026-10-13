/**
 * Resolves a `yami-media://` URL for a file through main: thumbnails via
 * `media.thumbnail(path, size)` (size encoded in the kind), full previews via
 * `media.preview(path)`.
 * The renderer never reads file contents itself.
 *
 * A URL can still fail to load: its token expired (maximum age) or was evicted or revoked
 * in main (download folder changed), or the file was replaced. The media element reports
 * that through `reportLoadError`, which drops the URL from the cache and fetches a fresh one
 * (at most once per file per `LOAD_RETRY_COOLDOWN_MS`); a failure after that is real and
 * the caller shows it.
 */
import { useCallback, useEffect, useState } from 'react';
import type { MediaUrlDto } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { useServices } from '../../app/services-context.tsx';
import { createLoadRetry, type MediaKind } from '../../shared/lib/media-cache.ts';

export type MediaUrlState =
  | { readonly status: 'idle' | 'loading'; readonly media: null; readonly error: null }
  | { readonly status: 'ready'; readonly media: MediaUrlDto; readonly error: null }
  | { readonly status: 'error'; readonly media: null; readonly error: AppErrorData };

const IDLE: MediaUrlState = { status: 'idle', media: null, error: null };
const LOADING: MediaUrlState = { status: 'loading', media: null, error: null };

export interface MediaUrlRecovery {
  /**
   * Call when the element failed to load `url` (the `media.url` it was given). A fresh URL is fetched
   * while the state stays `ready`, so the element stays mounted (a video resumes where it stopped) and
   * just receives the new URL. `onFinal` runs instead when the failure is real: this view refetched the
   * file moments ago, or main returned the very same URL (live token, unchanged file: the file itself
   * does not load). A failed refetch turns the state into `error`.
   */
  readonly reportLoadError: (url: string, onFinal: () => void) => void;
}

/** A refetch in flight after a load error. */
interface Recovery {
  readonly kind: MediaKind;
  readonly path: string;
  readonly url: string;
  readonly onFinal: () => void;
}

export function useMediaUrl(kind: MediaKind, path: string | null, enabled = true): MediaUrlState & MediaUrlRecovery {
  const { media, scheduler } = useServices();
  const [state, setState] = useState<MediaUrlState>(() => {
    const cached = path ? media.peek(kind, path) : null;
    return cached ? { status: 'ready', media: cached, error: null } : IDLE;
  });
  const [retry] = useState(() => createLoadRetry(scheduler.now));
  const [recovery, setRecovery] = useState<Recovery | null>(null);

  useEffect(() => {
    setRecovery(null);
    if (!path || !enabled) {
      setState(IDLE);
      return;
    }
    const cached = media.peek(kind, path);
    if (cached) {
      setState({ status: 'ready', media: cached, error: null });
      return;
    }
    setState(LOADING);
    return media.get(kind, path, (result) => {
      setState(
        result.ok
          ? { status: 'ready', media: result.media, error: null }
          : { status: 'error', media: null, error: result.error }
      );
    });
  }, [enabled, kind, media, path]);

  useEffect(() => {
    if (!recovery || !enabled || recovery.kind !== kind || recovery.path !== path) return;
    return media.get(kind, recovery.path, (result) => {
      setRecovery(null);
      if (!result.ok) setState({ status: 'error', media: null, error: result.error });
      else if (result.media.url === recovery.url) recovery.onFinal();
      else setState({ status: 'ready', media: result.media, error: null });
    });
  }, [enabled, kind, media, path, recovery]);

  const reportLoadError = useCallback(
    (url: string, onFinal: () => void): void => {
      if (!path || state.status !== 'ready') {
        onFinal();
        return;
      }
      // An older URL failing late, or one already being replaced: the element gets the current/new URL anyway.
      if (url !== state.media.url || recovery?.url === url) return;
      if (!retry.allow(JSON.stringify([kind, path]))) {
        onFinal();
        return;
      }
      media.forget(kind, path, url);
      setRecovery({ kind, path, url, onFinal });
    },
    [kind, media, path, recovery, retry, state]
  );

  return { ...state, reportLoadError };
}
