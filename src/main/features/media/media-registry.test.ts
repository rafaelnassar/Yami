import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEDIA_URL_LIMITS } from '../../../shared/contracts/ipc.ts';
import type { MediaFileIdentity } from './media-identity.ts';
import { MediaRegistry, type MediaEntry } from './media-registry.ts';

const identity = (realPath: string, over: Partial<MediaFileIdentity> = {}): MediaFileIdentity => ({
  realPath,
  dev: 1n,
  ino: 7n,
  size: 1,
  mtimeNs: 1n,
  ...over
});

const entry = (path: string, over: Partial<MediaEntry> = {}): MediaEntry => ({
  path,
  mime: 'video/mp4',
  name: 'v.mp4',
  identity: identity(path),
  ...over
});

function sequentialTokens(): () => string {
  let seq = 0;
  return () => `t${(seq += 1)}`;
}

describe('MediaRegistry token reuse', () => {
  it('returns the live token for an unchanged file instead of minting a new one', () => {
    const registry = new MediaRegistry({ now: () => 0, newToken: sequentialTokens() });
    const first = registry.register(entry('/dl/a.mp4'));
    assert.equal(registry.register(entry('/dl/a.mp4')), first);
    assert.equal(registry.size, 1);
    assert.equal(registry.resolve(first)?.path, '/dl/a.mp4');
  });

  it('issues a new token when the file, its identity or the mime differ', () => {
    const registry = new MediaRegistry({ now: () => 0, newToken: sequentialTokens() });
    const first = registry.register(entry('/dl/a.mp4'));
    const replaced = registry.register(entry('/dl/a.mp4', { identity: identity('/dl/a.mp4', { ino: 8n }) }));
    const grown = registry.register(entry('/dl/a.mp4', { identity: identity('/dl/a.mp4', { ino: 8n, size: 2 }) }));
    const otherMime = registry.register(entry('/dl/a.mp4', { mime: 'video/webm' }));
    const otherFile = registry.register(entry('/dl/b.mp4'));
    assert.equal(new Set([first, replaced, grown, otherMime, otherFile]).size, 5);
    // The newest token of a file is the one reused from now on.
    assert.equal(
      registry.register(entry('/dl/a.mp4', { identity: identity('/dl/a.mp4', { ino: 8n, size: 2 }) })),
      grown
    );
  });

  it('mints a new token once the previous one expired', () => {
    let now = 0;
    const registry = new MediaRegistry({ now: () => now, ttlMs: 1_000, newToken: sequentialTokens() });
    const first = registry.register(entry('/dl/a.mp4'));
    now = 1_000;
    const second = registry.register(entry('/dl/a.mp4'));
    assert.notEqual(second, first);
    assert.equal(registry.resolve(first), null);
    assert.equal(registry.resolve(second)?.path, '/dl/a.mp4');
  });

  it('evicts the least recently used token: reuse and requests count as use', () => {
    const registry = new MediaRegistry({ now: () => 0, maxEntries: 3, newToken: sequentialTokens() });
    const a = registry.register(entry('/a'));
    const b = registry.register(entry('/b'));
    const c = registry.register(entry('/c'));
    registry.register(entry('/a'));
    registry.register(entry('/d'));
    assert.equal(registry.resolve(b), null);
    assert.equal(registry.resolve(a)?.path, '/a');
    assert.equal(registry.resolve(c)?.path, '/c');
    registry.register(entry('/e'));
    assert.equal(registry.resolve(a)?.path, '/a', 'resolved just before, so /d was the oldest');
    assert.equal(registry.size, 3);
  });

  it('keeps a token alive while it is being requested (sliding lifetime)', () => {
    let now = 0;
    const registry = new MediaRegistry({ now: () => now, ttlMs: 1_000 });
    const token = registry.register(entry('/dl/long.mp4'));
    for (now = 800; now <= 4_000; now += 800) assert.ok(registry.resolve(token), `alive at ${now}`);
    now += 1_000;
    assert.equal(registry.resolve(token), null);
  });

  it('keeps a reopened video playable after scrolling through many thumbnails', () => {
    const registry = new MediaRegistry({ now: () => 0 });
    const video = registry.register(entry('/dl/a.mp4'));
    for (let i = 0; i < MEDIA_URL_LIMITS.cacheEntries * 2; i += 1) {
      registry.register(entry(`/cache/thumb-${i}.png`, { mime: 'image/png', name: `${i}.jpg` }));
    }
    assert.equal(registry.register(entry('/dl/a.mp4')), video);
    assert.equal(registry.resolve(video)?.path, '/dl/a.mp4');
  });

  it('forgets reuse bookkeeping on clear and bumps the generation', () => {
    const registry = new MediaRegistry({ now: () => 0, newToken: sequentialTokens() });
    const first = registry.register(entry('/dl/a.mp4'));
    const generation = registry.generation;
    registry.clear();
    assert.equal(registry.generation, generation + 1);
    assert.equal(registry.resolve(first), null);
    assert.notEqual(registry.register(entry('/dl/a.mp4')), first);
  });
});

describe('MediaRegistry maximum age', () => {
  it('caps the sliding lifetime: a token in constant use still dies at its maximum age', () => {
    let now = 0;
    const registry = new MediaRegistry({ now: () => now, ttlMs: 1_000, maxAgeMs: 5_000, reuseMarginMs: 0 });
    const token = registry.register(entry('/dl/long.mp4'));
    for (now = 500; now < 5_000; now += 500) assert.ok(registry.resolve(token), `alive at ${now}`);
    now = 5_000;
    assert.equal(registry.resolve(token), null);
  });

  it('never reuses an expired token, even before it was pruned', () => {
    let now = 0;
    const registry = new MediaRegistry({
      now: () => now,
      ttlMs: 10_000,
      maxAgeMs: 2_000,
      reuseMarginMs: 0,
      newToken: sequentialTokens()
    });
    const first = registry.register(entry('/dl/a.mp4'));
    now = 2_000;
    const second = registry.register(entry('/dl/a.mp4'));
    assert.notEqual(second, first);
    assert.equal(registry.resolve(first), null);
    assert.equal(registry.resolve(second)?.path, '/dl/a.mp4');
  });

  it('issues a fresh token when the live one would die before a renderer cache drops it', () => {
    let now = 0;
    const registry = new MediaRegistry({
      now: () => now,
      ttlMs: 10_000,
      maxAgeMs: 10_000,
      reuseMarginMs: 3_000,
      newToken: sequentialTokens()
    });
    const first = registry.register(entry('/dl/a.mp4'));
    now = 7_000;
    assert.equal(registry.register(entry('/dl/a.mp4')), first, 'exactly the margin left: reused');
    now = 7_001;
    const second = registry.register(entry('/dl/a.mp4'));
    assert.notEqual(second, first);
    // The old URL keeps working (e.g. a video playing from it) until its own maximum age.
    assert.ok(registry.resolve(first));
    assert.equal(registry.register(entry('/dl/a.mp4')), second);
    now = 10_000;
    assert.equal(registry.resolve(first), null);
    assert.ok(registry.resolve(second));
  });

  it('defaults: tokens are reused for a renderer cache lifetime and die within the maximum age', () => {
    let now = 0;
    const registry = new MediaRegistry({ now: () => now });
    const token = registry.register(entry('/dl/a.mp4'));
    const step = MEDIA_URL_LIMITS.tokenTtlMs / 2;
    for (now = step; now < MEDIA_URL_LIMITS.tokenMaxAgeMs; now += step) assert.ok(registry.resolve(token));
    now = MEDIA_URL_LIMITS.tokenMaxAgeMs;
    assert.equal(registry.resolve(token), null);
  });
});

describe('MEDIA_URL_LIMITS', () => {
  it('lets main outlast every renderer cache (main window + tray)', () => {
    assert.ok(MEDIA_URL_LIMITS.tokenEntries >= 2 * MEDIA_URL_LIMITS.cacheEntries);
    assert.ok(MEDIA_URL_LIMITS.tokenTtlMs > MEDIA_URL_LIMITS.cacheTtlMs);
    // Reuse needs `cacheTtlMs` of absolute lifetime left, so the maximum age must leave room for it.
    assert.ok(MEDIA_URL_LIMITS.tokenMaxAgeMs > 2 * MEDIA_URL_LIMITS.cacheTtlMs);
  });
});
