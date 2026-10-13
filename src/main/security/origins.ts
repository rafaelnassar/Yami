/**
 * Where the renderer comes from and which URLs count as "the app".
 *
 * Packaged (and unpackaged production builds): `app://yami/…`, served from
 * `dist/renderer` by the privileged `app:` scheme. Development: the Vite dev server
 * (`YAMI_DEV_SERVER_URL`). Dev mode requires an unpackaged app *and* an explicit dev
 * server variable, so running a production build with `electron .` never loads localhost.
 */
import type { AppView } from '../../shared/contracts/ipc.ts';

export const APP_SCHEME = 'app';
export const APP_HOST = 'yami';
export const MEDIA_SCHEME = 'yami-media';
export const DEFAULT_DEV_SERVER_URL = 'http://localhost:5173';

export interface RendererSourceInput {
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Returns the dev server origin, or `null` when the app must use `app://`. */
export function resolveDevServerUrl(input: RendererSourceInput): string | null {
  if (input.isPackaged) return null;
  const explicit = input.env['YAMI_DEV_SERVER_URL']?.trim();
  const devFlag = input.env['YAMI_DEV'] === '1';
  if (!explicit && !devFlag) return null;
  let url: URL;
  try {
    url = new URL(explicit || DEFAULT_DEV_SERVER_URL);
  } catch {
    return null;
  }
  // The dev server must be local: never trust a remote origin with the IPC bridge.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !local) return null;
  return `${url.protocol}//${url.host}`;
}

export class AppOrigin {
  readonly #devServer: string | null;
  readonly #protocol: string;
  readonly #host: string;

  constructor(devServerUrl: string | null) {
    this.#devServer = devServerUrl;
    if (devServerUrl) {
      const url = new URL(devServerUrl);
      this.#protocol = url.protocol;
      this.#host = url.host;
    } else {
      this.#protocol = `${APP_SCHEME}:`;
      this.#host = APP_HOST;
    }
  }

  get isDevServer(): boolean {
    return this.#devServer !== null;
  }

  /** e.g. `app://yami` or `http://localhost:5173`. */
  get origin(): string {
    return `${this.#protocol}//${this.#host}`;
  }

  entryUrl(view: AppView): string {
    const base = `${this.origin}/index.html`;
    return view === 'tray' ? `${base}?view=tray` : base;
  }

  /**
   * Scheme + host (+ port) comparison. `URL.origin` cannot be used: it is `"null"` for
   * custom schemes such as `app:`.
   */
  isAppUrl(raw: string): boolean {
    try {
      const url = new URL(raw);
      return url.protocol === this.#protocol && url.host === this.#host;
    } catch {
      return false;
    }
  }
}
