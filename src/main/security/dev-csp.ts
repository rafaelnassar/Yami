/**
 * Development only. The Vite dev server sends no CSP, so main adds one to every response
 * from the dev origin; production keeps `APP_CSP` from the `app:` handler, unchanged.
 * The dev policy is the production one plus exactly what Vite needs:
 * - `connect-src ws://<dev origin>` for the HMR socket;
 * - the React Refresh preamble that `@vitejs/plugin-react` inlines into `index.html`,
 *   allowed by its hash (no `'unsafe-inline'`/`'unsafe-eval'` for scripts: Vite needs
 *   neither, and inline scripts written by us must fail in dev as they do in production);
 * - inline styles (Vite injects CSS as `<style>`), already allowed in production.
 */
import { createHash } from 'node:crypto';
import { APP_CSP_DIRECTIVES, buildCsp } from './csp.ts';
import type { AppOrigin } from './origins.ts';

/**
 * `@vitejs/plugin-react` preamble for the dev base `/` (the config's `base: './'` resolves
 * to `/` when serving). `dev-csp.test.ts` compares it with the installed plugin; when the
 * plugin changes it, Chromium's CSP console error also prints the new hash.
 */
export const REACT_REFRESH_PREAMBLE = `import { injectIntoGlobalHook } from "/@react-refresh";
injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;`;

export function scriptHashSource(code: string): string {
  return `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
}

/** `devOrigin` is `AppOrigin.origin` in dev mode, e.g. `http://localhost:5173`. */
export function buildDevCsp(devOrigin: string): string {
  const url = new URL(devOrigin);
  // CSP host-sources cannot express IPv6 literals; `'self'` still covers the page itself.
  const hmr = url.hostname.startsWith('[') ? [] : [`ws://${url.host}`];
  return buildCsp({
    ...APP_CSP_DIRECTIVES,
    'script-src': [...(APP_CSP_DIRECTIVES['script-src'] ?? []), scriptHashSource(REACT_REFRESH_PREAMBLE)],
    'connect-src': [...(APP_CSP_DIRECTIVES['connect-src'] ?? []), ...hmr]
  });
}

export type ResponseHeaders = Record<string, string[]>;

/** Replaces any CSP header (whatever its casing) with `csp`. */
export function withCspHeader(headers: Readonly<ResponseHeaders> | undefined, csp: string): ResponseHeaders {
  const next: ResponseHeaders = {};
  for (const [name, values] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'content-security-policy') next[name] = values;
  }
  next['Content-Security-Policy'] = [csp];
  return next;
}

interface HeadersReceivedDetails {
  readonly url: string;
  readonly responseHeaders?: Record<string, string[]>;
}

interface HeadersReceivedResponse {
  responseHeaders?: Record<string, string[]>;
}

type HeadersReceivedListener = (
  details: HeadersReceivedDetails,
  callback: (response: HeadersReceivedResponse) => void
) => void;

/** The part of Electron's `Session` used here (injected for tests). */
export interface WebRequestSession {
  readonly webRequest: {
    onHeadersReceived(filter: { urls: string[] }, listener: HeadersReceivedListener): void;
  };
}

/**
 * Call only in dev mode (`origin.isDevServer`). Electron keeps one `onHeadersReceived`
 * listener per session, so nothing else may register one on the default session.
 */
export function installDevServerCsp(session: WebRequestSession, origin: Pick<AppOrigin, 'origin' | 'isAppUrl'>): void {
  const csp = buildDevCsp(origin.origin);
  session.webRequest.onHeadersReceived({ urls: [`${origin.origin}/*`] }, (details, callback) => {
    // The URL filter already scopes this; the origin check keeps it exact (scheme + host + port).
    if (!origin.isAppUrl(details.url)) {
      callback({});
      return;
    }
    callback({ responseHeaders: withCspHeader(details.responseHeaders, csp) });
  });
}
