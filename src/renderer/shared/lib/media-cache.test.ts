import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEDIA_URL_LIMITS, type IpcResult, type MediaUrlDto } from '../../../shared/contracts/ipc.ts';
import {
  LOAD_RETRY_COOLDOWN_MS,
  createLoadRetry,
  createMediaUrlCache,
  thumbnailKind,
  thumbnailSizeFor,
  type MediaKind,
  type MediaLookup
} from './media-cache.ts';

function deferred(): { promise: Promise<IpcResult<MediaUrlDto>>; resolve: (value: IpcResult<MediaUrlDto>) => void } {
  let resolve!: (value: IpcResult<MediaUrlDto>) => void;
  const promise = new Promise<IpcResult<MediaUrlDto>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const media = (url: string): IpcResult<MediaUrlDto> => ({
  ok: true,
  data: { url, mime: 'image/jpeg', sizeBytes: 1, name: 'a.jpg' }
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('media url cache', () => {
  it('dedupes concurrent requests and caches the result', async () => {
    const calls: Array<[MediaKind, string]> = [];
    const pending = deferred();
    const cache = createMediaUrlCache({
      fetcher: (kind, path) => (calls.push([kind, path]), pending.promise),
      now: () => 0
    });
    const results: MediaLookup[] = [];
    cache.get('thumbnail-small', '/a.jpg', (r) => results.push(r));
    cache.get('thumbnail-small', '/a.jpg', (r) => results.push(r));
    assert.equal(calls.length, 1);
    pending.resolve(media('yami-media://1'));
    await tick();
    assert.equal(results.length, 2);
    assert.equal(cache.peek('thumbnail-small', '/a.jpg')?.url, 'yami-media://1');
    assert.equal(cache.peek('preview', '/a.jpg'), null);
  });

  it('limits concurrency and skips cancelled queued requests', async () => {
    const calls: string[] = [];
    const resolvers = new Map<string, (value: IpcResult<MediaUrlDto>) => void>();
    const cache = createMediaUrlCache({
      fetcher: (_kind, path) => {
        calls.push(path);
        const d = deferred();
        resolvers.set(path, d.resolve);
        return d.promise;
      },
      now: () => 0,
      concurrency: 1
    });
    cache.get('thumbnail-small', '/1', () => undefined);
    const cancel = cache.get('thumbnail-small', '/2', () => undefined);
    cache.get('thumbnail-small', '/3', () => undefined);
    assert.deepEqual(calls, ['/1']);
    cancel();
    resolvers.get('/1')?.(media('u1'));
    await tick();
    assert.deepEqual(calls, ['/1', '/3']);
  });

  it('expires entries after the TTL and evicts the least recently used', async () => {
    let now = 0;
    const cache = createMediaUrlCache({
      fetcher: async (_k, path) => media(path),
      now: () => now,
      ttlMs: 100,
      maxEntries: 2
    });
    for (const path of ['/a', '/b']) cache.get('thumbnail-small', path, () => undefined);
    await tick();
    assert.equal(cache.size, 2);
    cache.peek('thumbnail-small', '/a');
    cache.get('thumbnail-small', '/c', () => undefined);
    await tick();
    assert.equal(cache.peek('thumbnail-small', '/b'), null);
    assert.ok(cache.peek('thumbnail-small', '/a'));
    now = 1_000;
    assert.equal(cache.peek('thumbnail-small', '/a'), null);
  });

  it('reports failures and invalidates paths', async () => {
    const cache = createMediaUrlCache({
      fetcher: async (_k, path) => (path === '/bad' ? { ok: false, error: { code: 'PATH_NOT_FOUND' } } : media(path)),
      now: () => 0
    });
    let failure: MediaLookup | null = null;
    cache.get('preview', '/bad', (r) => (failure = r));
    cache.get('preview', '/ok', () => undefined);
    await tick();
    assert.deepEqual(failure, { ok: false, error: { code: 'PATH_NOT_FOUND' } });
    cache.invalidate(['/ok']);
    assert.equal(cache.peek('preview', '/ok'), null);
  });

  it('caches small and large thumbnails of the same file separately', async () => {
    const calls: MediaKind[] = [];
    const cache = createMediaUrlCache({
      fetcher: async (kind, path) => (calls.push(kind), media(`${kind}:${path}`)),
      now: () => 0
    });
    cache.get(thumbnailKind('small'), '/a.jpg', () => undefined);
    cache.get(thumbnailKind('large'), '/a.jpg', () => undefined);
    await tick();
    assert.deepEqual(calls, ['thumbnail-small', 'thumbnail-large']);
    assert.equal(cache.peek('thumbnail-large', '/a.jpg')?.url, 'thumbnail-large:/a.jpg');
    assert.equal(cache.peek('thumbnail-small', '/a.jpg')?.url, 'thumbnail-small:/a.jpg');
    cache.invalidate(['/a.jpg']);
    assert.equal(cache.size, 0);
  });

  it('forgets a URL that failed to load so the next get asks main again', async () => {
    let issued = 0;
    const cache = createMediaUrlCache({ fetcher: async () => media(`yami-media://${(issued += 1)}`), now: () => 0 });
    const urls: string[] = [];
    const record = (result: MediaLookup): void => {
      if (result.ok) urls.push(result.media.url);
    };
    cache.get('preview', '/v.mp4', record);
    await tick();
    cache.forget('preview', '/v.mp4', 'yami-media://1');
    assert.equal(cache.peek('preview', '/v.mp4'), null);
    cache.get('preview', '/v.mp4', record);
    await tick();
    assert.deepEqual(urls, ['yami-media://1', 'yami-media://2']);
    assert.equal(issued, 2);
  });

  it('keeps a newer URL when a stale one is forgotten late', async () => {
    let issued = 0;
    const cache = createMediaUrlCache({ fetcher: async () => media(`yami-media://${(issued += 1)}`), now: () => 0 });
    cache.get('thumbnail-small', '/a.jpg', () => undefined);
    await tick();
    cache.forget('thumbnail-small', '/a.jpg', 'yami-media://1');
    cache.get('thumbnail-small', '/a.jpg', () => undefined);
    await tick();
    // A second view reports the same (already replaced) URL: the fresh one stays cached.
    cache.forget('thumbnail-small', '/a.jpg', 'yami-media://1');
    cache.forget('preview', '/a.jpg', 'yami-media://2');
    assert.equal(cache.peek('thumbnail-small', '/a.jpg')?.url, 'yami-media://2');
  });

  it('defaults to the shared limits, which main outlasts', async () => {
    let now = 0;
    const cache = createMediaUrlCache({ fetcher: async (_k, path) => media(path), now: () => now });
    for (let i = 0; i <= MEDIA_URL_LIMITS.cacheEntries; i += 1) cache.get('thumbnail-small', `/${i}`, () => undefined);
    for (let i = 0; i < 10; i += 1) await tick();
    assert.equal(cache.size, MEDIA_URL_LIMITS.cacheEntries);
    assert.equal(cache.peek('thumbnail-small', '/0'), null);
    now = MEDIA_URL_LIMITS.cacheTtlMs + 1;
    assert.equal(cache.peek('thumbnail-small', '/1'), null);
    assert.ok(
      MEDIA_URL_LIMITS.tokenEntries > MEDIA_URL_LIMITS.cacheEntries &&
        MEDIA_URL_LIMITS.tokenTtlMs > MEDIA_URL_LIMITS.cacheTtlMs
    );
  });

  it('allows one refetch per file per cooldown window after load errors', () => {
    let now = 0;
    const retry = createLoadRetry(() => now);
    const a = JSON.stringify(['preview', '/a.mp4']);
    const b = JSON.stringify(['preview', '/b.mp4']);
    assert.equal(retry.allow(a), true, 'first failure: refetch');
    now = 1_000;
    assert.equal(retry.allow(a), false, 'the fresh URL failed too: real failure');
    assert.equal(retry.allow(b), true, 'another file has its own budget');
    now += 1;
    assert.equal(retry.allow(a), true, 'the budget follows the file this view refetched last');
    now += LOAD_RETRY_COOLDOWN_MS - 1;
    assert.equal(retry.allow(a), false);
    now += 1;
    // A view left open for long recovers again later (token at its maximum age, folder change).
    assert.equal(retry.allow(a), true);
  });

  it('picks large thumbnails for tiles wider than the small rendition in device pixels', () => {
    assert.equal(thumbnailSizeFor(200, 1), 'small');
    assert.equal(thumbnailSizeFor(200, 2), 'large');
    assert.equal(thumbnailSizeFor(320, 1), 'small');
    assert.equal(thumbnailSizeFor(321, 1), 'large');
    assert.equal(thumbnailSizeFor(200, Number.NaN), 'small');
  });
});
