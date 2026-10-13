import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import type { DownloadRequest } from '../../application/runtime/ports.ts';
import { HttpsDownloader, type HttpsDownloaderOptions } from './https-downloader.ts';
import type { HttpGet, HttpResponse } from './https-client.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'yami-dl-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let fileCounter = 0;
function request(overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  fileCounter += 1;
  return {
    tool: 'yt-dlp',
    url: 'https://example.test/yt-dlp',
    destination: path.join(dir, `file-${fileCounter}`),
    expectedBytes: null,
    signal: new AbortController().signal,
    ...overrides
  };
}

function respond(status: number, body: Readable | Buffer | string, headers: Record<string, string> = {}): HttpResponse {
  const stream = body instanceof Readable ? body : Readable.from([Buffer.from(body)]);
  return { statusCode: status, headers, body: stream };
}

/** Routes by URL; records every requested URL. */
function router(routes: Record<string, () => HttpResponse>): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const get = async (url: URL) => {
    calls.push(url.href);
    const route = routes[url.href];
    if (!route) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return route();
  };
  return Object.assign(get, { calls });
}

function downloader(get: HttpGet, options: Partial<HttpsDownloaderOptions> = {}): HttpsDownloader {
  return new HttpsDownloader({ userAgent: 'test', get, retryDelayMs: 1, attempts: 1, ...options });
}

const PAYLOAD = Buffer.from('binary-payload-'.repeat(100));
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

describe('HttpsDownloader', () => {
  it('streams to disk, hashes and reports progress', async () => {
    const get = router({
      'https://example.test/yt-dlp': () => respond(302, '', { location: 'https://cdn.example.test/blob' }),
      'https://cdn.example.test/blob': () => respond(200, PAYLOAD, { 'content-length': String(PAYLOAD.length) })
    });
    const progress: Array<[number, number | null]> = [];
    const req = request({ expectedBytes: PAYLOAD.length, onProgress: (r, t) => progress.push([r, t]) });
    const result = await downloader(get).download(req);
    assert.ok(result.ok);
    assert.deepEqual(result.value, { bytes: PAYLOAD.length, sha256: PAYLOAD_SHA });
    assert.deepEqual(readFileSync(req.destination), PAYLOAD);
    assert.deepEqual(progress.at(-1), [PAYLOAD.length, PAYLOAD.length]);
  });

  it('rejects an https → http redirect (no downgrade) without retrying', async () => {
    const get = router({
      'https://example.test/yt-dlp': () => respond(301, '', { location: 'http://example.test/plain' })
    });
    const result = await downloader(get, { attempts: 3 }).download(request());
    assert.deepEqual(result.ok ? null : result.error, {
      code: ErrorCode.TOOLS_NETWORK_FAILED,
      params: { tool: 'yt-dlp', detail: 'insecure-redirect' }
    });
    assert.equal(get.calls.length, 1);
  });

  it('rejects plain http URLs and redirect loops', async () => {
    const plain = await downloader(router({})).download(request({ url: 'http://example.test/x' }));
    assert.equal(plain.ok ? null : plain.error.params?.['detail'], 'insecure-url');
    const loop = router({ 'https://example.test/yt-dlp': () => respond(302, '', { location: '/yt-dlp' }) });
    const looped = await downloader(loop).download(request());
    assert.equal(looped.ok ? null : looped.error.params?.['detail'], 'too-many-redirects');
    assert.equal(loop.calls.length, 6);
  });

  it('resolves with an error (no hang) when the connection drops mid-stream, and deletes the file', async () => {
    const body = new Readable({ read() {} });
    const get = router({ 'https://example.test/yt-dlp': () => respond(200, body, { 'content-length': '1000' }) });
    const req = request();
    const pending = downloader(get).download(req);
    body.push(Buffer.alloc(100));
    setTimeout(() => body.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 5);
    const result = await pending;
    assert.deepEqual(result.ok ? null : result.error, {
      code: ErrorCode.TOOLS_NETWORK_FAILED,
      params: { tool: 'yt-dlp', detail: 'ECONNRESET' }
    });
    assert.equal(existsSync(req.destination), false);
  });

  it('times out a stalled body and honours the caller abort signal', async () => {
    const stalled = () => respond(200, new Readable({ read() {} }), { 'content-length': '10' });
    const idle = await downloader(router({ 'https://example.test/yt-dlp': stalled }), { idleTimeoutMs: 20 }).download(
      request()
    );
    assert.equal(idle.ok ? null : idle.error.params?.['detail'], 'idle-timeout');

    const controller = new AbortController();
    const pending = downloader(router({ 'https://example.test/yt-dlp': stalled })).download(
      request({ signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 5);
    const aborted = await pending;
    assert.deepEqual(aborted.ok ? null : aborted.error, { code: ErrorCode.CANCELLED });
  });

  it('enforces the size cap with and without Content-Length', async () => {
    const announced = await downloader(
      router({ 'https://example.test/yt-dlp': () => respond(200, PAYLOAD, { 'content-length': '999999' }) }),
      {
        maxBytes: 100
      }
    ).download(request());
    assert.equal(announced.ok ? null : announced.error.code, ErrorCode.TOOLS_INSTALL_FAILED);

    const req = request();
    const streamed = await downloader(router({ 'https://example.test/yt-dlp': () => respond(200, PAYLOAD) }), {
      maxBytes: 100
    }).download(req);
    assert.equal(streamed.ok ? null : streamed.error.code, ErrorCode.TOOLS_INSTALL_FAILED);
    assert.equal(existsSync(req.destination), false);

    const mismatch = await downloader(router({ 'https://example.test/yt-dlp': () => respond(200, PAYLOAD) })).download(
      request({ expectedBytes: 5 })
    );
    assert.equal(mismatch.ok ? null : mismatch.error.code, ErrorCode.TOOLS_INTEGRITY_FAILED);
  });

  it('retries truncated downloads and transient HTTP errors, but not 404', async () => {
    let attempt = 0;
    const flaky = router({
      'https://example.test/yt-dlp': () => {
        attempt += 1;
        return attempt === 1
          ? respond(200, PAYLOAD.subarray(0, 10), { 'content-length': String(PAYLOAD.length) })
          : respond(200, PAYLOAD, { 'content-length': String(PAYLOAD.length) });
      }
    });
    const retried = await downloader(flaky, { attempts: 3 }).download(request());
    assert.ok(retried.ok);
    assert.equal(flaky.calls.length, 2);

    const missing = router({ 'https://example.test/yt-dlp': () => respond(404, 'nope') });
    const notFound = await downloader(missing, { attempts: 3 }).download(request());
    assert.equal(notFound.ok ? null : notFound.error.params?.['detail'], 'HTTP 404');
    assert.equal(missing.calls.length, 1);
  });
});
