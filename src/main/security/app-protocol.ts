/**
 * `app://yami/…` — serves the built renderer (`dist/renderer`) with path confinement,
 * correct MIME types and a strict CSP response header. Replaces the legacy `file://`
 * loading, where any local file shared the renderer's origin.
 */
import path from 'node:path';
import type { CustomScheme } from 'electron';
import { assetMimeType } from './mime-types.ts';
import { APP_HOST, APP_SCHEME } from './origins.ts';

export const APP_SCHEME_DEFINITION: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true }
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * Maps a URL pathname to a file inside `rootDir`, or `null` when it would escape it.
 * Rejects (after decoding) `.`/`..` segments, drive letters/ADS (`:`), control chars and
 * segments ending in a dot or space (Windows silently strips those, so `.. ` would act as `..`).
 */
export function resolveAssetPath(rootDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (CONTROL.test(decoded)) return null;
  const segments = decoded.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) segments.push('index.html');
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes(':') || /[. ]$/.test(segment)) return null;
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

export interface AppProtocolOptions {
  readonly rootDir: string;
  readonly csp: string;
  /** Returns the file bytes, or `null` when missing / not a regular file. */
  readonly readFile: (file: string) => Promise<Uint8Array | null>;
}

function textResponse(status: number, body: string, csp: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export function createAppProtocolHandler(options: AppProtocolOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return textResponse(405, 'Method Not Allowed', options.csp);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, 'Bad Request', options.csp);
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return textResponse(404, 'Not Found', options.csp);

    const file = resolveAssetPath(options.rootDir, url.pathname);
    if (!file) return textResponse(404, 'Not Found', options.csp);
    const bytes = await options.readFile(file);
    if (!bytes) return textResponse(404, 'Not Found', options.csp);

    const headers = {
      'Content-Type': assetMimeType(file),
      'Content-Length': String(bytes.byteLength),
      'Content-Security-Policy': options.csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache'
    };
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
  };
}
