import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it, mock } from 'node:test';
import { renameWithRetrySync, writeFileAtomicSync } from './atomic-file.ts';

const root = fs.mkdtempSync(path.join(tmpdir(), 'yami-atomic-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const realFsync = fs.fsyncSync;
const realRename = fs.renameSync;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function tempLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

/** Records fsync calls (file vs directory) and renames, in order, calling through. */
function recordDurability(): string[] {
  const steps: string[] = [];
  mock.method(fs, 'fsyncSync', (fd: number) => {
    steps.push(fs.fstatSync(fd).isDirectory() ? 'fsync:dir' : 'fsync:file');
    realFsync(fd);
  });
  mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    steps.push('rename');
    realRename(from, to);
  });
  return steps;
}

describe('writeFileAtomicSync', () => {
  it('replaces the file with the requested mode and leaves no temp file', () => {
    const file = path.join(root, 'a', 'key.bin');
    writeFileAtomicSync(file, 'one', { mode: 0o600, dirMode: 0o700 });
    writeFileAtomicSync(file, Buffer.from('two'), { mode: 0o600 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(tempLeftovers(path.dirname(file)), []);
  });

  it('fsyncs the temp file before the rename and the directory after it', () => {
    const steps = recordDurability();
    writeFileAtomicSync(path.join(root, 'b', 'settings.json'), '{}');
    // The directory sync is attempted everywhere (Node can open directories on Windows too; a
    // failing fsync is tolerated, see the next test).
    assert.deepEqual(steps, ['fsync:file', 'rename', 'fsync:dir']);
  });

  it('tolerates directories that cannot be synced', () => {
    mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw errno('EINVAL');
      realFsync(fd);
    });
    const file = path.join(root, 'c', 'dismissed.json');
    writeFileAtomicSync(file, '[]');
    assert.equal(fs.readFileSync(file, 'utf8'), '[]');
  });

  it('keeps the previous file when the new content cannot be synced', () => {
    const file = path.join(root, 'd', 'key.bin');
    writeFileAtomicSync(file, 'old');
    mock.method(fs, 'fsyncSync', () => {
      throw errno('EIO');
    });
    assert.throws(() => writeFileAtomicSync(file, 'new'), { code: 'EIO' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(tempLeftovers(path.dirname(file)), []);
  });

  it('skips fsync for non-durable writes (caches)', () => {
    const steps = recordDurability();
    writeFileAtomicSync(path.join(root, 'e', 'thumb.png'), Buffer.from([1, 2, 3]), { durable: false });
    assert.deepEqual(steps, ['rename']);
  });
});

describe('renameWithRetrySync', () => {
  it('retries transient Windows locks, then gives up on other errors', () => {
    const from = path.join(root, 'f-from');
    const to = path.join(root, 'f-to');
    fs.writeFileSync(from, 'x');
    let attempts = 0;
    mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      attempts += 1;
      if (attempts <= 2) throw errno('EBUSY');
      realRename(source, target);
    });
    renameWithRetrySync(from, to);
    assert.equal(attempts, 3);
    assert.equal(fs.readFileSync(to, 'utf8'), 'x');

    mock.restoreAll();
    assert.throws(() => renameWithRetrySync(path.join(root, 'missing'), to), { code: 'ENOENT' });
  });
});
