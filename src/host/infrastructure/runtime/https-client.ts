/**
 * Minimal HTTPS client shared by the downloader and the releases API.
 *
 * - HTTPS only, including every redirect hop (the legacy code followed
 *   https → http redirects in cleartext); at most 5 redirects.
 * - Header timeout per request; body idle timeouts are enforced by the callers.
 * - The raw `HttpGet` is injectable so tests can fake responses without sockets.
 */
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
}

export interface HttpRequestInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Time allowed until the response headers arrive. */
  readonly timeoutMs: number;
}

/** One GET, no redirect handling. */
export type HttpGet = (url: URL, init: HttpRequestInit) => Promise<HttpResponse>;

export type HttpErrorKind =
  | 'insecure-url'
  | 'insecure-redirect'
  | 'too-many-redirects'
  | 'redirect-without-location'
  | 'timeout'
  | 'idle-timeout'
  | 'http-status'
  | 'too-large'
  | 'incomplete'
  | 'size-mismatch';

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status: number | null;

  constructor(kind: HttpErrorKind, status: number | null = null) {
    super(status === null ? kind : `${kind} (HTTP ${status})`);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
  }
}

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const nodeHttpsGet: HttpGet = (url, init) =>
  new Promise<HttpResponse>((resolve, reject) => {
    if (url.protocol !== 'https:') {
      reject(new HttpError('insecure-url'));
      return;
    }
    const request = https.get(url, { headers: { ...init.headers }, signal: init.signal }, (response) => {
      clearTimeout(timer);
      resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response });
    });
    const timer = setTimeout(() => request.destroy(new HttpError('timeout')), init.timeoutMs);
    // Stays attached for the whole request: late socket errors must never be unhandled.
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function contentLength(headers: IncomingHttpHeaders): number | null {
  const raw = headerValue(headers['content-length']);
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function header(headers: IncomingHttpHeaders, name: string): string | null {
  return headerValue(headers[name.toLowerCase()]);
}

/** GET following up to `MAX_REDIRECTS` HTTPS redirects. Resolves with the final (non-redirect) response. */
export async function getFollowingRedirects(get: HttpGet, url: string, init: HttpRequestInit): Promise<HttpResponse> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new HttpError('insecure-url');
  }
  if (current.protocol !== 'https:') throw new HttpError('insecure-url');
  for (let hops = 0; ; hops += 1) {
    const response = await get(current, init);
    if (!REDIRECT_STATUSES.has(response.statusCode)) return response;
    response.body.destroy();
    const location = header(response.headers, 'location');
    if (!location) throw new HttpError('redirect-without-location', response.statusCode);
    if (hops >= MAX_REDIRECTS) throw new HttpError('too-many-redirects');
    const next = new URL(location, current);
    if (next.protocol !== 'https:') throw new HttpError('insecure-redirect');
    current = next;
  }
}

/** Reads a small body fully, failing past `maxBytes` or after `idleMs` without data. */
export async function readBody(body: Readable, maxBytes: number, idleMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => body.destroy(new HttpError('idle-timeout')), idleMs);
  };
  arm();
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) {
        body.destroy();
        throw new HttpError('too-large');
      }
      chunks.push(buffer);
      arm();
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}
