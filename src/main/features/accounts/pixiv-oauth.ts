/**
 * Pixiv login window. Modal, sandboxed, no preload, dedicated persistent partition;
 * top-level navigation limited to the login hosts; popups, <webview> and permissions
 * denied. The redirect carrying the code is captured and never loaded. The token is
 * exchanged with `net.fetch` (Chromium stack: system proxy/certificates apply).
 */
import { BrowserWindow, net, session } from 'electron';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import type { Logger } from '../../infrastructure/logger.ts';
import { lockDownSession } from '../../security/permissions.ts';
import {
  PIXIV_TOKEN_URL,
  PIXIV_TOKEN_USER_AGENT,
  createPkcePair,
  extractPixivAuthCode,
  isAllowedLoginNavigation,
  parseTokenResponse,
  pixivLoginUrl,
  tokenRequestBody,
  type PixivTokenResult
} from './pixiv-protocol.ts';

export const PIXIV_PARTITION = 'persist:pixiv-oauth';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

export interface PixivOAuthOptions {
  readonly parent: BrowserWindow | null;
  readonly title: string;
  readonly logger: Logger;
}

async function exchangeCode(code: string, verifier: string): Promise<Result<PixivTokenResult, AppErrorData>> {
  try {
    const response = await net.fetch(PIXIV_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': PIXIV_TOKEN_USER_AGENT },
      body: tokenRequestBody(code, verifier).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    });
    return parseTokenResponse(response.status, await response.text());
  } catch (error) {
    const detail = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
    return err(appError(ErrorCode.PIXIV_LOGIN_FAILED, { detail }));
  }
}

/** Browser-like UA for the login pages (the default one advertises Electron and the app). */
function browserUserAgent(raw: string): string {
  return raw.replace(/\s(?:Electron|yami|Yami)\/\S+/g, '');
}

export function runPixivOAuth(options: PixivOAuthOptions): Promise<Result<PixivTokenResult, AppErrorData>> {
  const pkce = createPkcePair();
  const oauthSession = session.fromPartition(PIXIV_PARTITION);
  // Also installed by the `session-created` hook; repeated here so this flow never depends on it.
  lockDownSession(oauthSession, () => false);

  return new Promise((resolve) => {
    const parent = options.parent && !options.parent.isDestroyed() ? options.parent : null;
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      show: false,
      ...(parent ? { parent, modal: true } : {}),
      autoHideMenuBar: true,
      title: options.title,
      webPreferences: {
        session: oauthSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: false
      }
    });
    const contents = win.webContents;
    let settled = false;
    let exchanging = false;

    const finish = (result: Result<PixivTokenResult, AppErrorData>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(err(appError(ErrorCode.PIXIV_LOGIN_FAILED, { detail: 'timeout' }))),
      LOGIN_TIMEOUT_MS
    );

    /** Returns true when `url` carried the code (the navigation must then be cancelled). */
    const capture = (url: string): boolean => {
      const code = extractPixivAuthCode(url);
      if (!code) return false;
      if (!exchanging) {
        exchanging = true;
        win.hide();
        void exchangeCode(code, pkce.verifier).then(finish);
      }
      return true;
    };

    contents.on('will-redirect', (event) => {
      if (capture(event.url) || (event.isMainFrame && !isAllowedLoginNavigation(event.url))) event.preventDefault();
    });
    contents.on('will-navigate', (event) => {
      if (capture(event.url) || !isAllowedLoginNavigation(event.url)) {
        event.preventDefault();
        if (!exchanging) options.logger.warn('pixiv login navigation blocked', { url: event.url });
      }
    });
    contents.on('will-frame-navigate', (event) => {
      // Sub-frames (captcha widgets) may load any https page; top level is handled above.
      if (!event.isMainFrame && !event.url.startsWith('https:')) event.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => void capture(url));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setUserAgent(browserUserAgent(contents.getUserAgent()));

    win.on('closed', () => {
      if (!exchanging) finish(err(appError(ErrorCode.PIXIV_LOGIN_CANCELLED)));
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && !exchanging) win.show();
    });

    win.loadURL(pixivLoginUrl(pkce.challenge)).catch((error: unknown) => {
      // Cancelling the captured redirect aborts the load (ERR_ABORTED): expected.
      if (settled || exchanging) return;
      options.logger.warn('pixiv login page failed to load', { error: String(error) });
      finish(err(appError(ErrorCode.PIXIV_LOGIN_FAILED, { detail: 'load' })));
    });
  });
}

/** Forgets the Pixiv web session (cookies, storage, cache) after disconnecting. */
export async function clearPixivSession(): Promise<void> {
  const oauthSession = session.fromPartition(PIXIV_PARTITION);
  await oauthSession.clearStorageData();
  await oauthSession.clearCache();
}
