import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { decodeCursor, encodeCursor, isLibraryMedia, NodeLibraryScanner } from './node-library-scanner.ts';

async function touch(file: string, mtimeSeconds: number, content = 'x'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtimeSeconds, mtimeSeconds);
}

describe('isLibraryMedia', () => {
  it('keeps media and drops sidecars, engine temp files and hidden files', () => {
    for (const name of ['a.jpg', 'b.MP4', 'c.opus', 'photo.f2.jpg']) assert.equal(isLibraryMedia(name), true, name);
    for (const name of [
      'a.mp4.part',
      'a.part-Frag12',
      'a.f137.mp4',
      'a.f140-1.m4a',
      'a.temp.mp4',
      'a.ytdl',
      'a.info.json',
      'a.en.vtt',
      'a.description',
      '.hidden.jpg',
      'doc.pdf',
      'notes.txt'
    ]) {
      assert.equal(isLibraryMedia(name), false, name);
    }
  });
});

describe('cursor', () => {
  it('round-trips and treats garbage as the start', () => {
    assert.equal(decodeCursor(encodeCursor(120)), 120);
    assert.equal(decodeCursor('not-a-cursor'), 0);
    assert.equal(decodeCursor(null), 0);
  });
});

async function trySymlink(target: string, linkPath: string, type?: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    // Windows without Developer Mode denies symlink creation (EPERM).
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  }
}

describe('NodeLibraryScanner', () => {
  let root = '';
  let outside = '';
  let symlinksOk = true;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'yami-lib-'));
    outside = await mkdtemp(path.join(os.tmpdir(), 'yami-lib-out-'));
    await touch(path.join(root, 'old.jpg'), 1_000);
    await touch(path.join(root, 'gallery-dl', 'site', 'album', 'mid.png'), 2_000, 'png!');
    await touch(path.join(root, 'yt-dlp', 'youtube', 'ch', 'new [id].mp4'), 3_000);
    await touch(path.join(root, 'yt-dlp', 'youtube', 'ch', 'new [id].info.json'), 3_500);
    await touch(path.join(root, 'yt-dlp', 'youtube', 'ch', 'partial [id].mp4.part'), 3_600);
    await touch(path.join(root, 'yt-dlp', 'youtube', 'ch', 'partial [id].f137.mp4'), 3_600);
    await touch(path.join(root, '.hidden', 'secret.jpg'), 4_000);
    await touch(path.join(outside, 'linked.jpg'), 5_000);
    // Prefer a junction on Windows (no admin); fall back to skipping symlink assertions.
    const dirLinked = await trySymlink(
      outside,
      path.join(root, 'link-dir'),
      process.platform === 'win32' ? 'junction' : undefined
    );
    const fileLinked = await trySymlink(path.join(outside, 'linked.jpg'), path.join(root, 'link.jpg'));
    symlinksOk = dirLinked && fileLinked;
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('lists media newest first, skipping hidden dirs, symlinks and temp/sidecar files', async () => {
    const scanner = new NodeLibraryScanner();
    const { files, nextCursor } = await scanner.scan(root, 100, null);
    assert.deepEqual(
      files.map((file) => file.name),
      ['new [id].mp4', 'mid.png', 'old.jpg']
    );
    assert.equal(nextCursor, null);
    // When symlinks could not be created (Windows without Developer Mode), we still
    // verify the regular tree; the symlink-skipping path is covered when available.
    if (symlinksOk) {
      assert.equal(
        files.some((file) => file.name === 'linked.jpg'),
        false,
        'symlink targets outside the root must be ignored'
      );
    }
    const mid = files[1];
    assert.equal(mid?.relativePath, path.join('gallery-dl', 'site', 'album', 'mid.png'));
    assert.equal(mid?.path, path.join(root, 'gallery-dl', 'site', 'album', 'mid.png'));
    assert.equal(mid?.sizeBytes, 4);
    assert.equal(mid?.modifiedAt, 2_000_000);
  });

  it('paginates with an opaque cursor', async () => {
    const scanner = new NodeLibraryScanner();
    const first = await scanner.scan(root, 2, null);
    assert.equal(first.files.length, 2);
    assert.ok(first.nextCursor);
    const second = await scanner.scan(root, 2, first.nextCursor);
    assert.deepEqual(
      second.files.map((file) => file.name),
      ['old.jpg']
    );
    assert.equal(second.nextCursor, null);
  });

  it('caches per root for the TTL and rescans after invalidate()', async () => {
    let now = 0;
    const scanner = new NodeLibraryScanner({ clock: { now: () => now }, cacheTtlMs: 30_000 });
    assert.equal((await scanner.scan(root, 100, null)).files.length, 3);
    await touch(path.join(root, 'fresh.webp'), 6_000);
    try {
      assert.equal((await scanner.scan(root, 100, null)).files.length, 3, 'served from cache');
      now += 31_000;
      assert.equal((await scanner.scan(root, 100, null)).files[0]?.name, 'fresh.webp', 'expired');
      await rm(path.join(root, 'fresh.webp'));
      scanner.invalidate();
      assert.equal((await scanner.scan(root, 100, null)).files.length, 3, 'invalidated');
    } finally {
      await rm(path.join(root, 'fresh.webp'), { force: true });
    }
  });

  it('keeps only the newest files when over the cap (not the first in directory order)', async () => {
    const scanner = new NodeLibraryScanner({ maxFiles: 2 });
    const { files } = await scanner.scan(root, 100, null);
    assert.deepEqual(
      files.map((file) => file.name),
      ['new [id].mp4', 'mid.png']
    );
  });

  it('returns an empty list for a missing root', async () => {
    const scanner = new NodeLibraryScanner();
    assert.deepEqual(await scanner.scan(path.join(root, 'nope'), 10, null), { files: [], nextCursor: null });
  });
});
