import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseByteRange } from './byte-range.ts';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { nodeMediaFiles } from './media-files.ts';
import { isSameMediaFile, type MediaFileIdentity } from './media-identity.ts';
import { createMediaProtocolHandler, mediaUrlFor, type MediaFileAccess } from './media-protocol.ts';
import { MediaRegistry } from './media-registry.ts';

describe('parseByteRange', () => {
  it('handles the single-range forms', () => {
    assert.deepEqual(parseByteRange(null, 100), { kind: 'full' });
    assert.deepEqual(parseByteRange('bytes=0-9', 100), { kind: 'partial', start: 0, end: 9 });
    assert.deepEqual(parseByteRange('bytes=90-', 100), { kind: 'partial', start: 90, end: 99 });
    assert.deepEqual(parseByteRange('bytes=-10', 100), { kind: 'partial', start: 90, end: 99 });
    assert.deepEqual(parseByteRange('bytes=-500', 100), { kind: 'partial', start: 0, end: 99 });
    assert.deepEqual(parseByteRange('bytes=50-5000', 100), { kind: 'partial', start: 50, end: 99 });
  });

  it('rejects unsatisfiable ranges and ignores multi-range requests', () => {
    assert.deepEqual(parseByteRange('bytes=100-', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=9-3', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=-', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=-0', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=a-b', 100), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=0-1', 0), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=0-1,5-6', 100), { kind: 'full' });
    assert.deepEqual(parseByteRange('items=0-1', 100), { kind: 'full' });
  });
});

const identity = (realPath: string, over: Partial<MediaFileIdentity> = {}): MediaFileIdentity => ({
  realPath,
  dev: 1n,
  ino: 7n,
  size: 1,
  mtimeNs: 1n,
  ...over
});

describe('MediaRegistry', () => {
  it('expires tokens after the TTL', () => {
    let now = 0;
    const registry = new MediaRegistry({ now: () => now, ttlMs: 1_000 });
    const token = registry.register({ path: '/a.png', mime: 'image/png', name: 'a.png', identity: identity('/a.png') });
    assert.equal(registry.resolve(token)?.path, '/a.png');
    now = 1_000;
    assert.equal(registry.resolve(token), null);
  });

  it('never exceeds the cap and evicts the oldest', () => {
    let seq = 0;
    const registry = new MediaRegistry({ now: () => 0, maxEntries: 3, newToken: () => `t${(seq += 1)}` });
    for (let i = 0; i < 5; i += 1)
      registry.register({ path: `/f${i}`, mime: 'image/png', name: 'f', identity: identity(`/f${i}`) });
    assert.equal(registry.size, 3);
    assert.equal(registry.resolve('t1'), null);
    assert.equal(registry.resolve('t5')?.path, '/f4');
  });

  it('issues unguessable hex tokens by default', () => {
    const registry = new MediaRegistry({ now: () => 0 });
    const token = registry.register({ path: '/a', mime: 'image/png', name: 'a', identity: identity('/a') });
    assert.match(token, /^[a-f0-9]{32}$/);
  });
});

describe('isSameMediaFile', () => {
  it('requires the same canonical path and file object, tolerating growth and touches', () => {
    const base = identity('/dl/v.mp4', { size: 10, mtimeNs: 5n });
    assert.equal(isSameMediaFile(base, { ...base, size: 20, mtimeNs: 9n }), true);
    assert.equal(isSameMediaFile(base, { ...base, realPath: '/elsewhere/v.mp4' }), false);
    assert.equal(isSameMediaFile(base, { ...base, ino: 8n }), false);
    assert.equal(isSameMediaFile(base, { ...base, dev: 2n }), false);
  });

  it('falls back to size + mtime where the filesystem reports no file ids', () => {
    const base = identity('/share/v.mp4', { ino: 0n, size: 10, mtimeNs: 5n });
    assert.equal(isSameMediaFile(base, { ...base }), true);
    assert.equal(isSameMediaFile(base, { ...base, size: 11 }), false);
    assert.equal(isSameMediaFile(base, { ...base, mtimeNs: 6n }), false);
  });
});

interface FakeEntry {
  content: string;
  realPath?: string;
  ino?: bigint;
}

/** In-memory files keyed by the registered path; tests mutate entries to simulate swaps. */
function fakeFiles(entries: Map<string, FakeEntry>): MediaFileAccess {
  return {
    identify: async (file) => {
      const entry = entries.get(file);
      if (!entry) return null;
      return identity(entry.realPath ?? file, { ino: entry.ino ?? 7n, size: Buffer.byteLength(entry.content) });
    },
    open: (file, start, end) => {
      const entry = [...entries.entries()].find(([key, value]) => (value.realPath ?? key) === file.realPath)?.[1];
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from((entry?.content ?? '').slice(start, end + 1)));
          controller.close();
        }
      });
    }
  };
}

function setup(files: Record<string, string>) {
  const entries = new Map<string, FakeEntry>(Object.entries(files).map(([key, content]) => [key, { content }]));
  const access = fakeFiles(entries);
  const registry = new MediaRegistry({ now: () => 0 });
  const handler = createMediaProtocolHandler(registry, access);
  const urlFor = async (file: string, mime = 'video/mp4'): Promise<string> => {
    const found = (await access.identify(file)) ?? identity(file);
    return mediaUrlFor(registry.register({ path: file, mime, name: 'x', identity: found }));
  };
  return { handler, urlFor, entries };
}

describe('media protocol handler', () => {
  it('serves the full file with nosniff/no-store headers', async () => {
    const { handler, urlFor } = setup({ '/v.mp4': '0123456789' });
    const response = await handler(new Request(await urlFor('/v.mp4')));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '0123456789');
  });

  it('answers a single range with 206 and Content-Range', async () => {
    const { handler, urlFor } = setup({ '/v.mp4': '0123456789' });
    const response = await handler(new Request(await urlFor('/v.mp4'), { headers: { Range: 'bytes=2-4' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(response.headers.get('content-length'), '3');
    assert.equal(await response.text(), '234');
  });

  it('answers 416 for unsatisfiable ranges', async () => {
    const { handler, urlFor } = setup({ '/v.mp4': '0123456789' });
    const response = await handler(new Request(await urlFor('/v.mp4'), { headers: { Range: 'bytes=20-' } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
  });

  it('serves zero-byte files with an empty 200', async () => {
    const { handler, urlFor } = setup({ '/empty.png': '' });
    const response = await handler(new Request(await urlFor('/empty.png', 'image/png')));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(await response.text(), '');
  });

  it('returns 404 for unknown tokens, foreign hosts and vanished files', async () => {
    const { handler, urlFor } = setup({});
    assert.equal((await handler(new Request('yami-media://m/deadbeefdeadbeefdeadbeef'))).status, 404);
    assert.equal((await handler(new Request('yami-media://other/deadbeefdeadbeefdeadbeef'))).status, 404);
    assert.equal((await handler(new Request(await urlFor('/gone.mp4')))).status, 404);
  });

  it('refuses a path that now resolves elsewhere or to another file, but follows growth', async () => {
    const { handler, urlFor, entries } = setup({ '/dl/v.mp4': '0123456789' });
    const url = await urlFor('/dl/v.mp4');
    entries.set('/dl/v.mp4', { content: '0123456789abc' });
    const grown = await handler(new Request(url));
    assert.equal(grown.status, 200);
    assert.equal(grown.headers.get('content-length'), '13');
    entries.set('/dl/v.mp4', { content: 'secret', realPath: '/home/u/.ssh/id_rsa' });
    assert.equal((await handler(new Request(url))).status, 404);
    entries.set('/dl/v.mp4', { content: 'other', ino: 99n });
    assert.equal((await handler(new Request(url))).status, 404);
    entries.delete('/dl/v.mp4');
    assert.equal((await handler(new Request(url))).status, 404);
  });

  it('supports HEAD without a body and rejects other methods', async () => {
    const { handler, urlFor } = setup({ '/v.mp4': '0123456789' });
    const url = await urlFor('/v.mp4');
    const head = await handler(new Request(url, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal((await handler(new Request(url, { method: 'POST', body: 'x' }))).status, 405);
  });
});

describe('media protocol on the real filesystem', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'yami-media-fs-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  function layout(name: string) {
    const dl = path.join(root, name, 'dl');
    const outside = path.join(root, name, 'outside');
    mkdirSync(path.join(dl, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(dl, 'sub', 'v.mp4'), 'video-bytes');
    writeFileSync(path.join(outside, 'v.mp4'), 'SECRET');
    const registry = new MediaRegistry({ now: () => 0 });
    const handler = createMediaProtocolHandler(registry, nodeMediaFiles);
    const register = async (file: string): Promise<string> => {
      const found = await nodeMediaFiles.identify(file);
      assert.ok(found);
      return mediaUrlFor(registry.register({ path: file, mime: 'video/mp4', name: 'v.mp4', identity: found }));
    };
    return { dl, outside, handler, register };
  }

  it('streams ranges of the registered file', async () => {
    const { dl, handler, register } = layout('ok');
    const url = await register(path.join(dl, 'sub', 'v.mp4'));
    const response = await handler(new Request(url, { headers: { Range: 'bytes=0-4' } }));
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'video');
  });

  it('refuses a directory swapped for a symlink after registration', async () => {
    const { dl, outside, handler, register } = layout('swap-dir');
    const url = await register(path.join(dl, 'sub', 'v.mp4'));
    rmSync(path.join(dl, 'sub'), { recursive: true });
    symlinkSync(outside, path.join(dl, 'sub'));
    assert.equal((await handler(new Request(url))).status, 404);
  });

  it('refuses a file replaced after registration', async () => {
    const { dl, handler, register } = layout('swap-file');
    const file = path.join(dl, 'sub', 'v.mp4');
    const url = await register(file);
    writeFileSync(`${file}.new`, 'replaced');
    renameSync(`${file}.new`, file);
    assert.equal((await handler(new Request(url))).status, 404);
  });

  it('errors the stream when the opened file is not the verified one', async () => {
    const { dl, outside } = layout('race');
    const file = path.join(dl, 'sub', 'v.mp4');
    const verified = await nodeMediaFiles.identify(file);
    assert.ok(verified);
    // Swap between the check and the open: same path, different file object.
    renameSync(path.join(outside, 'v.mp4'), file);
    const body = new Response(nodeMediaFiles.open(verified, 0, 5));
    await assert.rejects(body.text());
  });
});
