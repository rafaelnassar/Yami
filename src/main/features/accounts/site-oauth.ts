/**
 * gallery-dl OAuth flows for non-Pixiv sites (Pixiv stays in pixiv-oauth.ts).
 */
import { net } from 'electron';
import type { VaultSiteId } from '../../../shared/domain/oauth-sites.ts';
import { hostMatchesSite } from '../../../shared/domain/url.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { BrowserWindow } from 'electron';
import type { Logger } from '../../infrastructure/logger.ts';
import type { SiteOAuthResult } from './site-oauth-result.ts';
import { authorizationHeader, oauthNonce, oauthSignature, oauthTimestamp, parseFormBody } from './oauth1-crypto.ts';
import {
  captureExactRedirect,
  captureLocalhostRedirect,
  clearOAuthSession,
  runOAuthLoginWindow
} from './oauth-login-window.ts';

const LOCAL_REDIRECT = 'http://localhost:6414/';
const TOKEN_TIMEOUT_MS = 30_000;

export interface RunSiteOAuthOptions {
  readonly siteId: VaultSiteId;
  readonly parent: BrowserWindow | null;
  readonly title: string;
  readonly logger: Logger;
}

function partitionFor(siteId: string): string {
  return `persist:oauth-${siteId}`;
}

function allowedHttpsHosts(hosts: readonly string[]): (url: string) => boolean {
  return (raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' && url.hostname === 'localhost') return true;
      return url.protocol === 'https:' && hosts.some((h) => hostMatchesSite(url.hostname, h));
    } catch {
      return false;
    }
  };
}

async function fetchText(
  url: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<Result<{ status: number; body: string }, AppErrorData>> {
  try {
    const response = await net.fetch(url, { ...init, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    return ok({ status: response.status, body: await response.text() });
  } catch {
    return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'network' }));
  }
}

function parseJsonRecord(body: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(body);
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textField(data: Record<string, unknown> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function oauth2AuthorizationCode(options: {
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  extraAuthParams?: Record<string, string>;
  tokenHeaders?: Record<string, string>;
  tokenBodyExtra?: Record<string, string>;
  /** gallery-dl default: HTTP Basic with client_id:client_secret (Reddit uses empty secret). */
  useBasicAuth?: boolean;
  allowedHosts: readonly string[];
  capture: (url: string) => Readonly<Record<string, string>> | null;
  partition: string;
  parent: BrowserWindow | null;
  title: string;
  logger: Logger;
  tokenField: 'refresh_token' | 'access_token';
  kind: SiteOAuthResult['kind'];
}): Promise<Result<SiteOAuthResult, AppErrorData>> {
  const auth = new URL(options.authorizeUrl);
  auth.searchParams.set('client_id', options.clientId);
  auth.searchParams.set('redirect_uri', options.redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', options.scope);
  for (const [key, value] of Object.entries(options.extraAuthParams ?? {})) {
    auth.searchParams.set(key, value);
  }

  const redirect = await runOAuthLoginWindow({
    partition: options.partition,
    parent: options.parent,
    title: options.title,
    loginUrl: auth.toString(),
    logger: options.logger,
    isAllowedNavigation: allowedHttpsHosts(options.allowedHosts),
    captureRedirect: options.capture
  });
  if (!redirect.ok) return redirect;
  const code = redirect.value.code?.trim();
  if (!code) return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'no code' }));

  // gallery-dl: with HTTP Basic auth, client_id/secret stay out of the body.
  const useBasic = options.useBasicAuth !== false;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: options.redirectUri,
    ...options.tokenBodyExtra
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...options.tokenHeaders
  };
  if (useBasic) {
    headers.Authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', options.clientId);
    if (options.clientSecret) body.set('client_secret', options.clientSecret);
  }

  const token = await fetchText(options.tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString()
  });
  if (!token.ok) return token;
  const data = parseJsonRecord(token.value.body);
  if (token.value.status < 200 || token.value.status >= 300 || textField(data, 'error')) {
    return err(
      appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: textField(data, 'error') ?? `HTTP ${token.value.status}` })
    );
  }
  const refresh = textField(data, 'refresh_token');
  const access = textField(data, 'access_token');
  if (options.tokenField === 'refresh_token') {
    if (!refresh) return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'no refresh token' }));
    return ok({ kind: options.kind, refreshToken: refresh, userName: null, userId: null });
  }
  if (!access) return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'no access token' }));
  return ok({ kind: options.kind, accessToken: access, userName: null, userId: null });
}

async function oauth1Site(options: {
  requestTokenUrl: string;
  authorizeUrl: string;
  accessTokenUrl: string;
  apiKey: string;
  apiSecret: string;
  redirectUri: string;
  extraAuthorizeParams?: Record<string, string>;
  allowedHosts: readonly string[];
  partition: string;
  parent: BrowserWindow | null;
  title: string;
  logger: Logger;
}): Promise<Result<SiteOAuthResult, AppErrorData>> {
  const oauthParams = (): Record<string, string> => ({
    oauth_consumer_key: options.apiKey,
    oauth_nonce: oauthNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: oauthTimestamp(),
    oauth_version: '1.0'
  });

  const requestParams: Record<string, string> = {
    ...oauthParams(),
    oauth_callback: options.redirectUri
  };
  requestParams.oauth_signature = oauthSignature('POST', options.requestTokenUrl, requestParams, options.apiSecret);

  const request = await fetchText(options.requestTokenUrl, {
    method: 'POST',
    headers: { Authorization: authorizationHeader(requestParams) }
  });
  if (!request.ok) return request;
  const requestTokens = parseFormBody(request.value.body);
  const requestSecret = requestTokens.oauth_token_secret ?? '';
  const requestToken = requestTokens.oauth_token ?? '';
  if (!requestToken || !requestSecret) {
    return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'request token' }));
  }

  const authorize = new URL(options.authorizeUrl);
  authorize.searchParams.set('oauth_token', requestToken);
  for (const [key, value] of Object.entries(options.extraAuthorizeParams ?? {})) {
    authorize.searchParams.set(key, value);
  }

  const redirect = await runOAuthLoginWindow({
    partition: options.partition,
    parent: options.parent,
    title: options.title,
    loginUrl: authorize.toString(),
    logger: options.logger,
    isAllowedNavigation: allowedHttpsHosts(options.allowedHosts),
    captureRedirect: (url) => captureLocalhostRedirect(url, options.redirectUri)
  });
  if (!redirect.ok) return redirect;
  const verifier = redirect.value.oauth_verifier?.trim();
  if (!verifier) return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'no verifier' }));

  const accessParams: Record<string, string> = {
    ...oauthParams(),
    oauth_token: requestToken,
    oauth_verifier: verifier
  };
  accessParams.oauth_signature = oauthSignature(
    'POST',
    options.accessTokenUrl,
    accessParams,
    options.apiSecret,
    requestSecret
  );

  const access = await fetchText(options.accessTokenUrl, {
    method: 'POST',
    headers: { Authorization: authorizationHeader(accessParams) }
  });
  if (!access.ok) return access;
  const accessTokens = parseFormBody(access.value.body);
  const token = accessTokens.oauth_token ?? '';
  const secret = accessTokens.oauth_token_secret ?? '';
  if (!token || !secret) return err(appError(ErrorCode.OAUTH_LOGIN_FAILED, { detail: 'access token' }));
  return ok({
    kind: 'oauth1',
    accessToken: token,
    accessTokenSecret: secret,
    userName: null,
    userId: null
  });
}

export async function runSiteOAuth(options: RunSiteOAuthOptions): Promise<Result<SiteOAuthResult, AppErrorData>> {
  const { siteId, parent, title, logger } = options;
  const partition = partitionFor(siteId);

  switch (siteId) {
    case 'deviantart':
      return oauth2AuthorizationCode({
        authorizeUrl: 'https://www.deviantart.com/oauth2/authorize',
        tokenUrl: 'https://www.deviantart.com/oauth2/token',
        redirectUri: 'https://mikf.github.io/gallery-dl/oauth-redirect.html',
        clientId: '5388',
        clientSecret: '76b08c69cfb27f26d6161f9ab6d061a1',
        scope: 'browse user.manage',
        allowedHosts: ['deviantart.com'],
        capture: (url) => captureExactRedirect(url, 'https://mikf.github.io/gallery-dl/oauth-redirect.html'),
        partition,
        parent,
        title,
        logger,
        tokenField: 'refresh_token',
        kind: 'refresh-token'
      });
    case 'reddit': {
      return oauth2AuthorizationCode({
        authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
        tokenUrl: 'https://www.reddit.com/api/v1/access_token',
        redirectUri: LOCAL_REDIRECT,
        clientId: '6N9uN0krSDE-ig',
        clientSecret: '',
        scope: 'read history',
        extraAuthParams: { duration: 'permanent' },
        tokenHeaders: {
          'User-Agent': 'Python:gallery-dl:0.8.4 (by /u/mikf1)'
        },
        allowedHosts: ['reddit.com'],
        capture: (url) => captureLocalhostRedirect(url, LOCAL_REDIRECT),
        partition,
        parent,
        title,
        logger,
        tokenField: 'refresh_token',
        kind: 'refresh-token'
      });
    }
    case 'mastodon.social':
      return oauth2AuthorizationCode({
        authorizeUrl: 'https://mastodon.social/oauth/authorize',
        tokenUrl: 'https://mastodon.social/oauth/token',
        redirectUri: LOCAL_REDIRECT,
        clientId: 'dBSHdpsnOUZgxOnjKSQrWEPakO3ctM7HmsyoOd4FcRo',
        clientSecret: 'DdrODTHs_XoeOsNVXnILTMabtdpWrWOAtrmw91wU1zI',
        scope: 'read',
        allowedHosts: ['mastodon.social'],
        capture: (url) => captureLocalhostRedirect(url, LOCAL_REDIRECT),
        partition,
        parent,
        title,
        logger,
        tokenField: 'access_token',
        kind: 'access-token'
      });
    case 'pawoo':
      return oauth2AuthorizationCode({
        authorizeUrl: 'https://pawoo.net/oauth/authorize',
        tokenUrl: 'https://pawoo.net/oauth/token',
        redirectUri: LOCAL_REDIRECT,
        clientId: '978a25f843ec01e53d09be2c290cd75c782bc3b7fdbd7ea4164b9f3c3780c8ff',
        clientSecret: '9208e3d4a7997032cf4f1b0e12e5df388428ef1fadb446dcfeb4f5ed6872d97b',
        scope: 'read',
        allowedHosts: ['pawoo.net'],
        capture: (url) => captureLocalhostRedirect(url, LOCAL_REDIRECT),
        partition,
        parent,
        title,
        logger,
        tokenField: 'access_token',
        kind: 'access-token'
      });
    case 'baraag':
      return oauth2AuthorizationCode({
        authorizeUrl: 'https://baraag.net/oauth/authorize',
        tokenUrl: 'https://baraag.net/oauth/token',
        redirectUri: LOCAL_REDIRECT,
        clientId: 'czxx2qilLElYHQ_sm-lO8yXuGwOHxLX9RYYaD0-nq1o',
        clientSecret: 'haMaFdMBgK_-BIxufakmI2gFgkYjqmgXGEO2tB-R2xY',
        scope: 'read',
        allowedHosts: ['baraag.net'],
        capture: (url) => captureLocalhostRedirect(url, LOCAL_REDIRECT),
        partition,
        parent,
        title,
        logger,
        tokenField: 'access_token',
        kind: 'access-token'
      });
    case 'smugmug':
      return oauth1Site({
        requestTokenUrl: 'https://api.smugmug.com/services/oauth/1.0a/getRequestToken',
        authorizeUrl: 'https://api.smugmug.com/services/oauth/1.0a/authorize',
        accessTokenUrl: 'https://api.smugmug.com/services/oauth/1.0a/getAccessToken',
        apiKey: 'RCVHDGjcbc4Fhzq4qzqLdZmvwmwB6LM2',
        apiSecret: 'jGrdndvJqhTx8XSNs7TFTSSthhZHq92ddMpbpDpkDVNM7TDgnvLFMtfB5Mg5kH73',
        redirectUri: LOCAL_REDIRECT,
        extraAuthorizeParams: { perms: 'read' },
        allowedHosts: ['smugmug.com', 'api.smugmug.com'],
        partition,
        parent,
        title,
        logger
      });
    case 'tumblr':
      return oauth1Site({
        requestTokenUrl: 'https://www.tumblr.com/oauth/request_token',
        authorizeUrl: 'https://www.tumblr.com/oauth/authorize',
        accessTokenUrl: 'https://www.tumblr.com/oauth/access_token',
        apiKey: 'O3hU2tMi5e4Qs5t3vezEi6L0qRORJ5y9oUpSGsrWu8iA3UCc3B',
        apiSecret: 'sFdsK3PDdP2QpYMRAoq0oDnw0sFS24XigXmdfnaeNZpJpqAn03',
        redirectUri: LOCAL_REDIRECT,
        allowedHosts: ['tumblr.com'],
        partition,
        parent,
        title,
        logger
      });
    default:
      return err(appError(ErrorCode.NOT_SUPPORTED, { feature: siteId }));
  }
}

export async function clearSiteOAuthSession(siteId: VaultSiteId): Promise<void> {
  await clearOAuthSession(partitionFor(siteId));
}
