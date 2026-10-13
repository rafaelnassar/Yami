import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { NodeFileSystem } from './node-file-system.ts';

describe('NodeFileSystem', () => {
  let dir = '';
  const fs = new NodeFileSystem({ platform: process.platform === 'win32' ? 'win32' : 'linux' });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-fs-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('stat reports size, mtime and type; null when missing', async () => {
    const file = path.join(dir, 'a.jpg');
    await writeFile(file, 'hello');
    const info = await fs.stat(file);
    assert.equal(info?.sizeBytes, 5);
    assert.equal(info?.isDirectory, false);
    assert.ok((info?.modifiedAt ?? 0) > 0);
    assert.equal((await fs.stat(dir))?.isDirectory, true);
    assert.equal(await fs.stat(path.join(dir, 'missing')), null);
  });

  it('removeFile deletes files, refuses directories and reports missing files', async () => {
    const file = path.join(dir, 'a.jpg');
    await writeFile(file, 'x');
    assert.deepEqual(await fs.removeFile(file), { ok: true, value: undefined });
    assert.equal(await fs.stat(file), null);
    const removeDir = await fs.removeFile(dir);
    assert.equal(!removeDir.ok && removeDir.error.code, ErrorCode.FILE_OPERATION_FAILED);
    const missing = await fs.removeFile(file);
    assert.equal(!missing.ok && missing.error.code, ErrorCode.PATH_NOT_FOUND);
  });

  it('renameDirectory renames in place and refuses existing targets', async () => {
    await mkdir(path.join(dir, 'old'));
    await writeFile(path.join(dir, 'old', 'x.jpg'), 'x');
    await mkdir(path.join(dir, 'taken'));
    const taken = await fs.renameDirectory(path.join(dir, 'old'), path.join(dir, 'taken'));
    assert.equal(!taken.ok && taken.error.code, ErrorCode.FOLDER_ALREADY_EXISTS);
    assert.deepEqual(await fs.renameDirectory(path.join(dir, 'old'), path.join(dir, 'new')), {
      ok: true,
      value: undefined
    });
    assert.deepEqual(await readdir(path.join(dir, 'new')), ['x.jpg']);
  });

  it('renameDirectory validates source and parent', async () => {
    const missing = await fs.renameDirectory(path.join(dir, 'nope'), path.join(dir, 'x'));
    assert.equal(!missing.ok && missing.error.code, ErrorCode.PATH_NOT_FOUND);
    await writeFile(path.join(dir, 'file'), 'x');
    const notDir = await fs.renameDirectory(path.join(dir, 'file'), path.join(dir, 'x'));
    assert.equal(!notDir.ok && notDir.error.code, ErrorCode.PATH_NOT_FOUND);
    await mkdir(path.join(dir, 'a'));
    const moved = await fs.renameDirectory(path.join(dir, 'a'), path.join(dir, 'sub', 'a'));
    assert.equal(!moved.ok && moved.error.code, ErrorCode.PATH_INVALID);
  });

  it('allows case-only renames (same inode) — refused by the legacy app on case-insensitive disks', async () => {
    await mkdir(path.join(dir, 'Foo'));
    const result = await fs.renameDirectory(path.join(dir, 'Foo'), path.join(dir, 'foo'));
    assert.ok(result.ok);
    assert.deepEqual(await readdir(dir), ['foo']);
  });

  it('ensureDir creates nested directories', async () => {
    await fs.ensureDir(path.join(dir, 'a', 'b', 'c'));
    assert.equal((await fs.stat(path.join(dir, 'a', 'b', 'c')))?.isDirectory, true);
  });
});
