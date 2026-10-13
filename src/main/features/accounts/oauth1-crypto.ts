/** Minimal OAuth 1.0a signing (HMAC-SHA1) for gallery-dl site logins. */
import { createHash, createHmac, randomBytes } from 'node:crypto';

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key] ?? '')}`)
    .join('&');
}

export function oauthNonce(): string {
  return randomBytes(16).toString('hex');
}

export function oauthTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

export function signingKey(consumerSecret: string, tokenSecret = ''): string {
  return `${encode(consumerSecret)}&${encode(tokenSecret)}`;
}

export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret = ''
): string {
  const baseUrl = new URL(url);
  baseUrl.search = '';
  baseUrl.hash = '';
  const base = `${method.toUpperCase()}&${encode(baseUrl.toString())}&${encode(normalizeParams(params))}`;
  return createHmac('sha1', signingKey(consumerSecret, tokenSecret)).update(base).digest('base64');
}

export function authorizationHeader(params: Record<string, string>): string {
  const parts = Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}="${encode(params[key] ?? '')}"`);
  return `OAuth ${parts.join(', ')}`;
}

export function parseFormBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    if (!rawKey) continue;
    out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
  }
  return out;
}

export function sha1Hex(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
