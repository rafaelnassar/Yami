/**
 * IPC sender validation. A message is trusted only when it comes from the *top-level
 * frame* of one of our windows *and* that frame currently shows the app origin.
 *
 * The legacy check compared only `webContents.id`, so a window that navigated elsewhere
 * (e.g. a dropped `file://` page) kept full access to the bridge.
 */
import type { AppView } from '../../shared/contracts/ipc.ts';

export interface SenderFrameLike {
  readonly url: string;
  readonly parent: unknown;
  isDestroyed?(): boolean;
}

export interface SenderInfo {
  /** `event.sender.id` */
  readonly webContentsId: number;
  /** `event.senderFrame` (may be null when the frame navigated or was destroyed). */
  readonly frame: SenderFrameLike | null;
}

export interface SenderPolicyDeps {
  /** Which app window owns this webContents, or `null` when it is not ours. */
  readonly viewOf: (webContentsId: number) => AppView | null;
  readonly isAppUrl: (url: string) => boolean;
}

/** Returns the trusted window kind, or `null` when the sender must be rejected. */
export function resolveTrustedSender(info: SenderInfo, deps: SenderPolicyDeps): AppView | null {
  const view = deps.viewOf(info.webContentsId);
  if (!view) return null;
  const frame = info.frame;
  if (!frame || frame.isDestroyed?.() === true) return null;
  if (frame.parent !== null) return null;
  return deps.isAppUrl(frame.url) ? view : null;
}
