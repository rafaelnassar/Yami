/**
 * yt-dlp browser-cookie retry (legacy `nextYtDlpCookieRetry`, spec 02 §2.8),
 * expressed on classified engine errors instead of re-parsing translated text.
 *
 * - The browser cookie database could not be copied while browser cookies were
 *   used → retry once WITHOUT browser cookies (`skip`).
 * - The site asked for a login/bot check while browser cookies were NOT used →
 *   retry once WITH browser cookies (`force`), but ONLY when the user opted in to
 *   browser cookies: an error text chosen by a remote server must never make the
 *   app read the browser's cookie store on its own.
 *
 * Only failed runs are retried, and each direction at most once per download
 * (reset by an explicit restart).
 */
import type { Engine } from '../../../shared/domain/engine.ts';
import type { OutcomeKind } from '../../../shared/domain/download.ts';
import type { EngineErrorKind } from '../engines/parsed-line.ts';
import type { CookieRetryMode, RetryState } from './download-state.ts';

export interface CookieRetryInput {
  readonly engine: Engine;
  readonly outcomeKind: OutcomeKind;
  readonly errorKind: EngineErrorKind | null;
  readonly usedBrowserCookies: boolean;
  /** The user setting "use cookies from the browser" (`settings.cookies.fromBrowser`). */
  readonly browserCookiesOptIn: boolean;
  readonly retry: RetryState;
}

export function nextCookieRetry(input: CookieRetryInput): CookieRetryMode | null {
  if (input.engine !== 'yt-dlp') return null;
  if (input.outcomeKind !== 'error' && input.outcomeKind !== 'empty') return null;
  if (input.errorKind === 'cookie-copy' && input.usedBrowserCookies && !input.retry.skipTried) return 'skip';
  if (
    input.errorKind === 'cookies-auth' &&
    input.browserCookiesOptIn &&
    !input.usedBrowserCookies &&
    !input.retry.forceTried
  ) {
    return 'force';
  }
  return null;
}
