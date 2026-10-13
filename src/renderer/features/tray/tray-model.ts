/** Status line of the tray quick panel (pure). */
import { isHttpUrl } from '../../../shared/domain/url.ts';

export type TrayPhase = 'idle' | 'starting' | 'ok' | 'error';

export type TrayStatus =
  | { readonly kind: 'error' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'engine-missing' }
  | { readonly kind: 'invalid-url' }
  | null;

export interface TrayStatusInput {
  readonly phase: TrayPhase;
  readonly ready: boolean;
  readonly engineAvailable: boolean;
  readonly url: string;
}

/** Priority: request error → engine not ready → selected engine missing → invalid URL. */
export function trayStatus(input: TrayStatusInput): TrayStatus {
  if (input.phase === 'error') return { kind: 'error' };
  if (!input.ready) return { kind: 'waiting' };
  if (!input.engineAvailable) return { kind: 'engine-missing' };
  if (input.url.trim() && !isHttpUrl(input.url)) return { kind: 'invalid-url' };
  return null;
}

/** Both Enter and the button require a ready host (legacy Enter skipped that check). */
export function canSubmitTray(input: TrayStatusInput): boolean {
  return input.ready && input.engineAvailable && input.phase !== 'starting' && isHttpUrl(input.url);
}

/** Height sent to main for the transparent popup window (bounded by the IPC schema). */
export function trayWindowHeight(contentHeight: number): number {
  return Math.min(720, Math.max(80, Math.ceil(contentHeight)));
}
