/**
 * Pure parts of the Pixiv OAuth (PKCE S256) flow — the same flow gallery-dl's
 * `oauth:pixiv` uses.
 *
 * ToS/maintenance risk: the client id/secret below are the public credentials of the
 * official Pixiv Android app (also embedded in gallery-dl). Pixiv may rotate or block
 * them at any time; this is not an API Pixiv offers to third parties.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { hostMatchesSite } from '../../../shared/domain/url.ts';

export const PIXIV_CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
export const PIXIV_CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
export const PIXIV_REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
export const PIXIV_LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
export const PIXIV_TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
export const PIXIV_TOKEN_USER_AGENT = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function challengeFor(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function createPkcePair(random: (size: number) => Uint8Array = randomBytes): PkcePair {
  const verifier = base64Url(random(32));
  return { verifier, challenge: challengeFor(verifier) };
}

export function pixivLoginUrl(challenge: string): string {
  const url = new URL(PIXIV_LOGIN_URL);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('client', 'pixiv-android');
  return url.toString();
}

/**
 * Authorization code from the redirect: either the https callback page
 * (`…/users/auth/pixiv/callback?code=`) or the app deep link it forwards to
 * (`pixiv://account/login?code=`).
 */
export function extractPixivAuthCode(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const code = url.searchParams.get('code')?.trim();
  if (!code) return null;
  if (url.protocol === 'pixiv:') return url.host === 'account' && url.pathname.startsWith('/login') ? code : null;
  const callback =
    url.protocol === 'https:' &&
    hostMatchesSite(url.hostname, 'pixiv.net') &&
    /\/users\/auth\/pixiv\/callback/i.test(url.pathname);
  return callback ? code : null;
}

/**
 * Hosts the login window may navigate to at top level: Pixiv itself plus the identity
 * providers Pixiv offers for social login. Everything else is blocked.
 */
const LOGIN_SITES = ['pixiv.net', 'accounts.google.com', 'appleid.apple.com', 'x.com', 'twitter.com', 'facebook.com'];

export function isAllowedLoginNavigation(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && LOGIN_SITES.some((site) => hostMatchesSite(url.hostname, site));
  } catch {
    return false;
  }
}

export function tokenRequestBody(code: string, verifier: string): URLSearchParams {
  return new URLSearchParams({
    client_id: PIXIV_CLIENT_ID,
    client_secret: PIXIV_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    include_policy: 'true',
    redirect_uri: PIXIV_REDIRECT_URI
  });
}

export interface PixivTokenResult {
  readonly refreshToken: string;
  readonly userName: string | null;
  readonly userId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function failed(detail: string): Result<never, AppErrorData> {
  return err(appError(ErrorCode.PIXIV_LOGIN_FAILED, { detail: detail.slice(0, 120) }));
}

/** Parses the token endpoint reply; tolerant of non-JSON bodies (proxies, HTML error pages). */
export function parseTokenResponse(status: number, body: string): Result<PixivTokenResult, AppErrorData> {
  let data: Record<string, unknown> | null = null;
  try {
    data = record(JSON.parse(body));
  } catch {
    data = null;
  }
  const errorCode = data ? text(data['error']) : null;
  if (status < 200 || status >= 300 || errorCode) return failed(errorCode ?? `HTTP ${status}`);
  if (!data) return failed('invalid response');

  const nested = record(data['response']);
  const refreshToken = text(data['refresh_token']) ?? text(nested?.['refresh_token']);
  if (!refreshToken) return failed('no refresh token');
  const user = record(data['user']) ?? record(nested?.['user']);
  return ok({
    refreshToken,
    userName: (text(user?.['name']) ?? text(user?.['account']))?.slice(0, 256) ?? null,
    userId: text(user?.['id'])?.slice(0, 64) ?? null
  });
}
