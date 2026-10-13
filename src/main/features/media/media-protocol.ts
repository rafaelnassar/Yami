/**
 * `yami-media://m/<token>` — streams registered media files to the renderer with Range
 * support (video seeking). No `bypassCSP`: the app CSP explicitly allows `yami-media:` for
 * images and media only. Replaces the legacy 127.0.0.1 preview server.
 *
 * A token lives for a while (sliding lifetime with an absolute cap, see `media-registry.ts`;
 * revoked when the download folder changes), so every request re-resolves the registered path and
 * refuses (404) unless it is still the very file that was validated (`isSameMediaFile`):
 * a symlink/junction or another file swapped in after registration is never served. The
 * check is local (realpath + stat), with no host round-trip.
 */
import type { CustomScheme } from 'electron';
import { MEDIA_SCHEME } from '../../security/origins.ts';
import { parseByteRange } from './byte-range.ts';
import { isSameMediaFile, type MediaFileIdentity } from './media-identity.ts';
import type { MediaRegistry } from './media-registry.ts';

export const MEDIA_HOST = 'm';

export const MEDIA_SCHEME_DEFINITION: CustomScheme = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
};

export function mediaUrlFor(token: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${token}`;
}

/** File access used by the handler (injected: real fs in production, fakes in tests). */
export interface MediaFileAccess {
  /** Resolves links and identifies the regular file behind `path`; `null` when missing or not a regular file. */
  identify(path: string): Promise<MediaFileIdentity | null>;
  /**
   * Byte stream for the inclusive range `[start, end]` of `file.realPath`. The stream
   * errors if the file actually opened is not `file` (swap between check and open).
   */
  open(file: MediaFileIdentity, start: number, end: number): ReadableStream<Uint8Array>;
}

const BASE_HEADERS = {
  'Accept-Ranges': 'bytes',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
} as const;

function plain(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, ...extra } });
}

export function createMediaProtocolHandler(
  registry: MediaRegistry,
  files: MediaFileAccess
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400);
    }
    const token = url.pathname.replace(/^\/+/, '');
    const entry = url.host === MEDIA_HOST && /^[a-f0-9]{16,64}$/.test(token) ? registry.resolve(token) : null;
    if (!entry) return plain(404);

    const current = await files.identify(entry.path);
    if (!current || !isSameMediaFile(entry.identity, current)) return plain(404);
    const size = current.size;

    const range = parseByteRange(request.headers.get('range'), size);
    if (range.kind === 'unsatisfiable') return plain(416, { 'Content-Range': `bytes */${size}` });

    const start = range.kind === 'partial' ? range.start : 0;
    const end = range.kind === 'partial' ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': entry.mime,
      'Content-Length': String(length)
    };
    if (range.kind === 'partial') headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const status = range.kind === 'partial' ? 206 : 200;
    // Zero-byte files get an empty body (legacy tried to stream `end: -1` and failed).
    const body = request.method === 'HEAD' || length === 0 ? null : files.open(current, start, end);
    return new Response(body, { status, headers });
  };
}
