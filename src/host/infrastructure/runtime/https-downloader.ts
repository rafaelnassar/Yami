/**
 * Streams a tool asset to disk over HTTPS, hashing (SHA-256) while it streams.
 *
 * Fixes of the legacy downloader: `stream.pipeline` (an aborted/closed response
 * rejects instead of hanging forever), a body idle timeout on top of the header
 * timeout, an overall `AbortSignal`, a hard size cap, exact Content-Length /
 * expected-size checks (legacy accepted files up to 5 % short), HTTPS-only
 * redirects, bounded retries for transient failures, throttled progress.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { delay } from '../../../shared/kernel/async.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { Downloader, DownloadedFile, DownloadRequest } from '../../application/runtime/ports.ts';
import { contentLength, getFollowingRedirects, HttpError, nodeHttpsGet, type HttpGet } from './https-client.ts';
import { classifyError, type ClassifiedError } from './network-errors.ts';

export interface HttpsDownloaderOptions {
  readonly userAgent: string;
  readonly get?: HttpGet;
  readonly headerTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Hard cap when the manifest has no size. */
  readonly maxBytes?: number;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly progressIntervalMs?: number;
  readonly now?: () => number;
}

type Attempt = { readonly ok: true; readonly value: DownloadedFile } | ({ readonly ok: false } & ClassifiedError);

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

export class HttpsDownloader implements Downloader {
  readonly #options: Required<HttpsDownloaderOptions>;

  constructor(options: HttpsDownloaderOptions) {
    this.#options = {
      get: nodeHttpsGet,
      headerTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
      maxBytes: DEFAULT_MAX_BYTES,
      attempts: 3,
      retryDelayMs: 1_000,
      progressIntervalMs: 250,
      now: Date.now,
      ...options
    };
  }

  async download(request: DownloadRequest): Promise<Result<DownloadedFile, AppErrorData>> {
    const { attempts, retryDelayMs } = this.#options;
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.#attempt(request);
      if (result.ok) return ok(result.value);
      if (!result.retryable || attempt >= attempts || request.signal.aborted) return err(result.error);
      try {
        await delay(retryDelayMs * attempt, request.signal);
      } catch {
        return err(classifyError(request.tool, null, true).error);
      }
    }
  }

  async #attempt(request: DownloadRequest): Promise<Attempt> {
    const { get, headerTimeoutMs, idleTimeoutMs, maxBytes } = this.#options;
    if (request.signal.aborted) return { ok: false, ...classifyError(request.tool, null, true) };
    // Local controller: aborted by the caller's signal or by our idle watchdog.
    const controller = new AbortController();
    const forward = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', forward, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new HttpError('idle-timeout')), idleTimeoutMs);
    };

    try {
      const response = await getFollowingRedirects(get, request.url, {
        headers: { 'User-Agent': this.#options.userAgent, Accept: 'application/octet-stream' },
        signal: controller.signal,
        timeoutMs: headerTimeoutMs
      });
      if (response.statusCode !== 200) {
        response.body.destroy();
        throw new HttpError('http-status', response.statusCode);
      }
      const total = contentLength(response.headers);
      const expected = request.expectedBytes;
      if (expected !== null && total !== null && total !== expected) {
        response.body.destroy();
        throw new HttpError('size-mismatch');
      }
      const limit = expected ?? maxBytes;
      if (total !== null && total > limit) {
        response.body.destroy();
        throw new HttpError('too-large');
      }

      const hash = createHash('sha256');
      let received = 0;
      const report = this.#progressReporter(request, total ?? expected);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > limit) {
            callback(new HttpError(expected === null ? 'too-large' : 'size-mismatch'));
            return;
          }
          hash.update(chunk);
          armIdle();
          report(received, false);
          callback(null, chunk);
        }
      });
      armIdle();
      await pipeline(response.body, meter, createWriteStream(request.destination, { mode: 0o600 }), {
        signal: controller.signal
      });
      if (total !== null && received !== total) throw new HttpError('incomplete');
      if (expected !== null && received !== expected) throw new HttpError('size-mismatch');
      report(received, true);
      return { ok: true, value: { bytes: received, sha256: hash.digest('hex') } };
    } catch (error) {
      await rm(request.destination, { force: true }).catch(() => undefined);
      const reason: unknown = controller.signal.aborted && !request.signal.aborted ? controller.signal.reason : error;
      return { ok: false, ...classifyError(request.tool, reason, request.signal.aborted) };
    } finally {
      clearTimeout(idleTimer);
      request.signal.removeEventListener('abort', forward);
    }
  }

  #progressReporter(request: DownloadRequest, total: number | null): (received: number, final: boolean) => void {
    const { progressIntervalMs, now } = this.#options;
    let last = -Infinity;
    return (received, final) => {
      const at = now();
      if (!final && at - last < progressIntervalMs) return;
      last = at;
      request.onProgress?.(received, total);
    };
  }
}
