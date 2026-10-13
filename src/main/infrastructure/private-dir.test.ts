import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PROBE_HTML, withLegacyProbePage } from './legacy-probe-page.ts';
import { nullLogger } from './logger.ts';
import { ensurePrivateDirSync, isPrivateDir } from './private-dir.ts';

const root = mkdtempSync(path.join(tmpdir(), 'yami-private-'));
after(() => rmSync(root, { recursive: true, force: true }));

const posix = process.platform !== 'win32';
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const options = { platform: process.platform, uid, logger: nullLogger };
let seq = 0;
const fresh = (): string => path.join(root, `case-${(seq += 1)}`, 'userData', 'tmp');

describe('isPrivateDir', () => {
  const stats = (over: Partial<{ dir: boolean; link: boolean; uid: number; mode: number }> = {}) => ({
    isDirectory: () => over.dir ?? true,
    isSymbolicLink: () => over.link ?? false,
    uid: over.uid ?? 1000,
    mode: over.mode ?? 0o40700
  });

  it('requires a real directory owned by us without group/other access on POSIX', () => {
    const linux = { platform: 'linux' as const, uid: 1000 };
    assert.equal(isPrivateDir(stats(), linux), true);
    assert.equal(isPrivateDir(stats({ mode: 0o40750 }), linux), false);
    assert.equal(isPrivateDir(stats({ mode: 0o41777 }), linux), false);
    assert.equal(isPrivateDir(stats({ uid: 1001 }), linux), false);
    assert.equal(isPrivateDir(stats({ link: true }), linux), false);
    assert.equal(isPrivateDir(stats({ dir: false }), linux), false);
  });

  it('only rejects links and non-directories on Windows (profile ACLs apply)', () => {
    const win = { platform: 'win32' as const, uid: null };
    assert.equal(isPrivateDir(stats({ mode: 0o40777, uid: 0 }), win), true);
    assert.equal(isPrivateDir(stats({ link: true }), win), false);
    assert.equal(isPrivateDir(stats({ dir: false }), win), false);
  });
});

describe('ensurePrivateDirSync', { skip: !posix }, () => {
  it('creates a missing directory (and its parents) with mode 0700', () => {
    const dir = fresh();
    assert.equal(ensurePrivateDirSync(dir, options), dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it('keeps an existing private directory and its contents', () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(path.join(dir, 'keep'), 'x');
    assert.equal(ensurePrivateDirSync(dir, options), dir);
    assert.equal(existsSync(path.join(dir, 'keep')), true);
  });

  it('recreates a directory other users could write to', () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    writeFileSync(path.join(dir, 'planted.html'), '<script>evil()</script>');
    assert.equal(ensurePrivateDirSync(dir, options), dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('replaces a planted symlink without touching its target', () => {
    const dir = fresh();
    const target = path.join(path.dirname(dir), 'elsewhere');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(target, 'victim'), 'data');
    symlinkSync(target, dir);
    assert.equal(ensurePrivateDirSync(dir, options), dir);
    assert.equal(lstatSync(dir).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(target, 'victim'), 'utf8'), 'data');
  });

  it('replaces a regular file squatting on the path', () => {
    const dir = fresh();
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, 'not a dir');
    assert.equal(ensurePrivateDirSync(dir, options), dir);
    assert.equal(statSync(dir).isDirectory(), true);
  });

  it('falls back to a fresh random 0700 sibling when the directory cannot be made ours', () => {
    const dir = fresh();
    // Simulates a foreign owner: whatever is created never matches this uid.
    const foreign = { ...options, uid: (uid ?? 0) + 4242 };
    const used = ensurePrivateDirSync(dir, foreign);
    assert.notEqual(used, dir);
    assert.equal(path.dirname(used), path.dirname(dir));
    assert.match(path.basename(used), /^tmp-/);
    assert.equal(statSync(used).mode & 0o777, 0o700);
  });

  it('accepts ACL-protected directories on Windows but still refuses links', () => {
    const win = { platform: 'win32' as const, uid: null, logger: nullLogger };
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    assert.equal(ensurePrivateDirSync(dir, win), dir);
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    const linked = fresh();
    mkdirSync(path.dirname(linked), { recursive: true });
    symlinkSync(dir, linked);
    assert.equal(ensurePrivateDirSync(linked, win), linked);
    assert.equal(lstatSync(linked).isSymbolicLink(), false);
  });
});

describe('withLegacyProbePage', () => {
  it('writes the probe as 0600 in a fresh 0700 subdirectory and removes it afterwards', async () => {
    const tempDir = fresh();
    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await withLegacyProbePage(tempDir, nullLogger, async (file) => {
        seen.push(file);
        assert.equal(path.dirname(path.dirname(file)), tempDir);
        assert.equal(readFileSync(file, 'utf8'), PROBE_HTML);
        if (posix) {
          assert.equal(statSync(file).mode & 0o777, 0o600);
          assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
        }
      });
    }
    assert.notEqual(path.dirname(seen[0] ?? ''), path.dirname(seen[1] ?? ''));
    assert.deepEqual(readdirSync(tempDir), []);
  });

  it('cleans up when the probe fails', async () => {
    const tempDir = fresh();
    await assert.rejects(
      withLegacyProbePage(tempDir, nullLogger, async () => {
        throw new Error('window failed');
      }),
      /window failed/
    );
    assert.deepEqual(readdirSync(tempDir), []);
  });
});
