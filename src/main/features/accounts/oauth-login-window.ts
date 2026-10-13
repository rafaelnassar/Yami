/**
 * Shared OAuth login BrowserWindow — captures redirect query params and cancels navigation.
 */
import { BrowserWindow, session } from 'electron';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { Logger } from '../../infrastructure/logger.ts';
import { lockDownSession } from '../../security/permissions.ts';

const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface OAuthLoginWindowOptions {
  readonly partition: string;
  readonly parent: BrowserWindow | null;
  readonly title: string;
  readonly loginUrl: string;
  readonly logger: Logger;
  readonly isAllowedNavigation: (url: string) => boolean;
  /** Return captured query params when the redirect URL matches; otherwise null. */
  readonly captureRedirect: (url: string) => Readonly<Record<string, string>> | null;
}

function browserUserAgent(raw: string): string {
  return raw.replace(/\s(?:Electron|yami|Yami)\/\S+/g, '');
}

function queryParams(raw: string): Readonly<Record<string, string>> | null {
  try {
    const url = new URL(raw);
    const out: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  } catch {
    return null;
  }
}

export function runOAuthLoginWindow(
  options: OAuthLoginWindowOptions
): Promise<Result<Readonly<Record<string, string>>, AppErrorData>> {
  const oauthSession = session.fromPartition(options.partition);
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
    let captured = false;

    const finish = (result: Result<Readonly<Record<string, string>>, AppErrorData>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'timeout' }))),
      LOGIN_TIMEOUT_MS
    );

    const tryCapture = (url: string): boolean => {
      const params = options.captureRedirect(url);
      if (!params) return false;
      if (!captured) {
        captured = true;
        win.hide();
        finish(ok(params));
      }
      return true;
    };

    contents.on('will-redirect', (event) => {
      if (tryCapture(event.url) || (event.isMainFrame && !options.isAllowedNavigation(event.url))) {
        event.preventDefault();
      }
    });
    contents.on('will-navigate', (event) => {
      if (tryCapture(event.url) || !options.isAllowedNavigation(event.url)) {
        event.preventDefault();
        if (!captured) options.logger.warn('oauth login navigation blocked', { url: event.url });
      }
    });
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && !event.url.startsWith('https:')) event.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => {
      void tryCapture(url);
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setUserAgent(browserUserAgent(contents.getUserAgent()));

    win.on('closed', () => {
      if (!captured) finish(err(appError(ErrorCode.OAUTH_LOGIN_CANCELLED)));
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && !captured) win.show();
    });

    win.loadURL(options.loginUrl).catch((error: unknown) => {
      if (settled || captured) return;
      options.logger.warn('oauth login page failed to load', { error: String(error) });
      finish(err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'load' })));
    });
  });
}

export function captureLocalhostRedirect(url: string, redirectUri: string): Readonly<Record<string, string>> | null {
  try {
    const target = new URL(redirectUri);
    const current = new URL(url);
    if (current.origin !== target.origin) return null;
    if (target.pathname !== '/' && !current.pathname.startsWith(target.pathname)) return null;
    return queryParams(url);
  } catch {
    return null;
  }
}

export function captureExactRedirect(url: string, redirectPrefix: string): Readonly<Record<string, string>> | null {
  if (!url.startsWith(redirectPrefix)) return null;
  return queryParams(url);
}

export async function clearOAuthSession(partition: string): Promise<void> {
  const oauthSession = session.fromPartition(partition);
  await oauthSession.clearStorageData();
  await oauthSession.clearCache();
}
