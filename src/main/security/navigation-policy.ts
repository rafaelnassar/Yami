/**
 * Navigation hardening for app windows: only the app origin may be loaded; every other
 * navigation is blocked; http(s) links go to the OS browser; popups and <webview> are denied.
 * Fixes the legacy policy that accepted any `file:` URL and ignored redirects.
 */
import type { WebContents } from 'electron';
import { parseHttpUrl } from '../../shared/domain/url.ts';
import type { Logger } from '../infrastructure/logger.ts';

export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * `allow` for the app origin; `external` for http(s) when the navigation was user-initiated
 * on the main frame (a plain link); `block` otherwise.
 */
export function decideNavigation(
  url: string,
  isAppUrl: (url: string) => boolean,
  userLink: boolean
): NavigationDecision {
  if (isAppUrl(url)) return 'allow';
  if (userLink && parseHttpUrl(url)) return 'external';
  return 'block';
}

/** Validates a URL before handing it to `shell.openExternal` (http/https only). */
export function externalUrlOf(raw: string): string | null {
  const url = parseHttpUrl(raw);
  return url ? url.toString() : null;
}

export interface NavigationPolicyDeps {
  readonly isAppUrl: (url: string) => boolean;
  readonly openExternal: (url: string) => void;
  readonly logger: Logger;
}

export function applyNavigationPolicy(contents: WebContents, deps: NavigationPolicyDeps): void {
  const openIfHttp = (raw: string): void => {
    const url = externalUrlOf(raw);
    if (url) deps.openExternal(url);
  };

  contents.on('will-navigate', (event) => {
    const decision = decideNavigation(event.url, deps.isAppUrl, true);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') openIfHttp(event.url);
    else deps.logger.warn('navigation blocked', { url: event.url });
  });

  // Covers sub-frames too (the app has none). External opening is left to `will-navigate`
  // so a link click never opens the browser twice.
  contents.on('will-frame-navigate', (event) => {
    if (!deps.isAppUrl(event.url)) event.preventDefault();
  });

  contents.on('will-redirect', (event) => {
    if (!deps.isAppUrl(event.url)) {
      event.preventDefault();
      deps.logger.warn('redirect blocked', { url: event.url });
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    openIfHttp(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
