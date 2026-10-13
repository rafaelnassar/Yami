import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { type EntryOwnership, NodeSandboxFileSystem, type SandboxFileSystem } from './canonical-path.ts';
import { NodePathSandbox } from './node-path-sandbox.ts';

function errorOf(result: Result<string, AppErrorData>): AppErrorData | null {
  return result.ok ? null : result.error;
}

/**
 * Real fs, except that the directories ABOVE the fixture root (the OS temp dir,
 * shared by design) count as private — otherwise the 'shared' rule would reject
 * every fixture when the tests do not run as the temp dir's owner.
 */
class FixtureFs extends NodeSandboxFileSystem {
  readonly #root: string;
  constructor(root: string) {
    super();
    this.#root = root;
  }
  override async ownership(target: string): Promise<EntryOwnership | null> {
    const info = await super.ownership(target);
    const relative = path.relative(target, this.#root);
    const above = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    return info && above ? { ...info, mode: info.mode & ~0o002 } : info;
  }
}

describe('NodePathSandbox (POSIX, real temp dirs)', { skip: process.platform === 'win32' }, () => {
  let base = '';
  let home = '';
  let dl = '';
  let appData = '';
  let runtimeDir = '';
  let outside = '';
  let sandbox: NodePathSandbox;

  before(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yami-sandbox-')));
    home = path.join(base, 'home');
    dl = path.join(home, 'Downloads', 'Yami');
    appData = path.join(home, '.config', 'Yami');
    runtimeDir = path.join(base, 'runtime');
    outside = path.join(base, 'outside');
    for (const dir of [dl, appData, runtimeDir, outside]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(dl, 'clip.mp4'), 'x');
    await writeFile(path.join(outside, 'secret.txt'), 'nope');
    await symlink(outside, path.join(dl, 'escape'));
    await symlink(path.join(outside, 'missing.txt'), path.join(dl, 'dangling'));
    await symlink(appData, path.join(base, 'link-to-appdata'));
    sandbox = new NodePathSandbox({
      protectedDirs: [appData, runtimeDir],
      platform: 'linux',
      homeDir: home,
      initialDownloadDir: dl,
      fs: new FixtureFs(base)
    });
  });
  after(() => rm(base, { recursive: true, force: true }));

  describe('resolveInside', () => {
    it('allows files inside the download dir, including missing partials (ported)', async () => {
      assert.deepEqual(await sandbox.resolveInside(path.join(dl, 'clip.mp4')), {
        ok: true,
        value: path.join(dl, 'clip.mp4')
      });
      const pending = path.join(dl, 'yt-dlp', 'pending.part');
      assert.deepEqual(await sandbox.resolveInside(pending), { ok: true, value: pending });
      assert.deepEqual(await sandbox.resolveInside(dl), { ok: true, value: dl });
    });

    it('resolves relative inputs against the download dir, not the host cwd', async () => {
      assert.deepEqual(await sandbox.resolveInside('clip.mp4'), { ok: true, value: path.join(dl, 'clip.mp4') });
    });

    it('reports PATH_NOT_FOUND for missing targets when mustExist', async () => {
      assert.equal(
        errorOf(await sandbox.resolveInside(path.join(dl, 'nope.mp4'), { mustExist: true }))?.code,
        ErrorCode.PATH_NOT_FOUND
      );
    });

    it('rejects traversal and paths outside the download dir (ported)', async () => {
      for (const input of [
        path.join(outside, 'secret.txt'),
        path.join(dl, '..', 'secret.txt'),
        path.join(dl, 'a', '..', '..', 'secret.txt'),
        '../../outside/secret.txt'
      ]) {
        assert.equal(errorOf(await sandbox.resolveInside(input))?.code, ErrorCode.PATH_OUTSIDE_SANDBOX, input);
      }
    });

    it('rejects empty, NUL and \\\\?\\ / \\\\.\\ prefixed input', async () => {
      for (const input of ['', 'inside\0.txt', `\\\\?\\${dl}/clip.mp4`, '\\\\.\\pipe\\x']) {
        assert.equal(errorOf(await sandbox.resolveInside(input))?.code, ErrorCode.PATH_INVALID, JSON.stringify(input));
      }
    });

    it('follows symlinks: a link inside that points outside is rejected', async () => {
      assert.equal(
        errorOf(await sandbox.resolveInside(path.join(dl, 'escape', 'secret.txt')))?.code,
        ErrorCode.PATH_OUTSIDE_SANDBOX
      );
      assert.equal(
        errorOf(await sandbox.resolveInside(path.join(dl, 'escape', 'new-file')))?.code,
        ErrorCode.PATH_OUTSIDE_SANDBOX
      );
    });

    it('rejects dangling symlinks (their target could be anywhere)', async () => {
      assert.equal(errorOf(await sandbox.resolveInside(path.join(dl, 'dangling')))?.code, ErrorCode.PATH_INVALID);
    });

    it('accepts names that start with ".." and contain ":" (legacy quirks)', async () => {
      assert.ok((await sandbox.resolveInside(path.join(dl, '..hidden', 'x.jpg'))).ok);
      assert.ok((await sandbox.resolveInside(path.join(dl, 'Re: talk 10:30.mp4'))).ok);
    });

    it('rejects protected dirs even when they sit inside the download dir', async () => {
      const lax = new NodePathSandbox({
        protectedDirs: [appData],
        platform: 'linux',
        homeDir: home,
        initialDownloadDir: home,
        fs: new FixtureFs(base)
      });
      assert.equal(
        errorOf(await lax.resolveInside(path.join(appData, 'vault', 'key')))?.code,
        ErrorCode.PATH_OUTSIDE_SANDBOX
      );
      assert.ok((await lax.resolveInside(path.join(dl, 'clip.mp4'))).ok);
    });
  });

  describe('validateDownloadDir', () => {
    it('accepts a normal directory, creates it and returns its realpath', async () => {
      const target = path.join(home, 'Videos', 'Yami');
      assert.deepEqual(await sandbox.validateDownloadDir(`  ${target}  `), { ok: true, value: target });
      assert.ok((await sandbox.resolveInside(path.join(dl, 'clip.mp4'))).ok);
    });

    it('rejects relative paths, disk roots and system dirs (including subfolders)', async () => {
      assert.deepEqual(errorOf(await sandbox.validateDownloadDir('Downloads')), {
        code: ErrorCode.DOWNLOAD_DIR_FORBIDDEN,
        params: { reason: 'relative' }
      });
      assert.deepEqual(errorOf(await sandbox.validateDownloadDir('/')), {
        code: ErrorCode.DOWNLOAD_DIR_FORBIDDEN,
        params: { reason: 'root' }
      });
      for (const input of ['/etc', '/usr/local/yami-downloads', '/var/lib/x']) {
        assert.deepEqual(errorOf(await sandbox.validateDownloadDir(input))?.params, { reason: 'system' }, input);
      }
    });

    it('rejects the home directory itself', async () => {
      assert.deepEqual(errorOf(await sandbox.validateDownloadDir(home))?.params, { reason: 'home' });
    });

    it('is bidirectional: rejects dirs inside AND dirs containing a protected dir', async () => {
      const inside = path.join(appData, 'downloads');
      const containing = path.join(home, '.config');
      for (const input of [appData, inside, containing, base, runtimeDir]) {
        assert.deepEqual(errorOf(await sandbox.validateDownloadDir(input))?.params, { reason: 'protected' }, input);
      }
    });

    it('realpaths the candidate (a symlink to a protected dir is rejected)', async () => {
      assert.deepEqual(errorOf(await sandbox.validateDownloadDir(path.join(base, 'link-to-appdata', 'dl')))?.params, {
        reason: 'protected'
      });
    });

    it('rejects invalid input and existing files', async () => {
      assert.equal(errorOf(await sandbox.validateDownloadDir('bad\0path'))?.code, ErrorCode.PATH_INVALID);
      assert.equal(errorOf(await sandbox.validateDownloadDir('   '))?.code, ErrorCode.PATH_INVALID);
      assert.equal(errorOf(await sandbox.validateDownloadDir(`\\\\?\\${outside}`))?.code, ErrorCode.PATH_INVALID);
      assert.equal(
        errorOf(await sandbox.validateDownloadDir(path.join(outside, 'secret.txt')))?.code,
        ErrorCode.PATH_INVALID
      );
    });

    it('exempts paths inside the home directory from the system-dir rule', async () => {
      const custom = new NodePathSandbox({
        protectedDirs: [],
        platform: 'linux',
        homeDir: home,
        initialDownloadDir: dl,
        systemDirs: [base],
        fs: new FixtureFs(base)
      });
      assert.ok((await custom.validateDownloadDir(path.join(home, 'Media'))).ok);
      assert.deepEqual(errorOf(await custom.validateDownloadDir(path.join(base, 'elsewhere')))?.params, {
        reason: 'system'
      });
    });

    describe('shared (world-writable) directories', () => {
      const me = process.geteuid?.() ?? 0;
      let shared = '';

      before(async () => {
        shared = path.join(base, 'shared');
        await mkdir(shared);
        await chmod(shared, 0o1777); // like /tmp: world-writable + sticky
      });

      function asUser(uid: number, fs: SandboxFileSystem = new FixtureFs(base)): NodePathSandbox {
        return new NodePathSandbox({
          protectedDirs: [appData],
          platform: 'linux',
          homeDir: home,
          initialDownloadDir: dl,
          fs,
          uid
        });
      }

      it('rejects a world-writable dir owned by someone else, and anything under it (nothing is created)', async () => {
        const other = asUser(me + 1);
        assert.deepEqual(errorOf(await other.validateDownloadDir(shared)), {
          code: ErrorCode.DOWNLOAD_DIR_FORBIDDEN,
          params: { reason: 'shared' }
        });
        const nested = path.join(shared, 'Yami', 'dl');
        assert.deepEqual(errorOf(await other.validateDownloadDir(nested))?.params, { reason: 'shared' });
        await assert.rejects(() => stat(path.join(shared, 'Yami')));
      });

      it('accepts a world-writable dir owned by the current user', async () => {
        assert.deepEqual(await asUser(me).validateDownloadDir(path.join(shared, 'mine')), {
          ok: true,
          value: path.join(shared, 'mine')
        });
      });

      it('rejects the real OS temp dir for anyone but its owner', async (t) => {
        const tmp = await realpath(os.tmpdir());
        const info = await stat(tmp);
        if ((info.mode & 0o002) === 0) {
          t.skip('the OS temp dir is not world-writable here');
          return;
        }
        const target = path.join(tmp, `yami-shared-probe-${process.pid}`);
        const result = await asUser(info.uid + 1, new NodeSandboxFileSystem()).validateDownloadDir(target);
        assert.deepEqual(errorOf(result)?.params, { reason: 'shared' });
        await assert.rejects(() => stat(target));
      });
    });
  });
});

/** In-memory POSIX tree with owners and modes. */
class FakePosixFs implements SandboxFileSystem {
  readonly entries = new Map<string, EntryOwnership>();

  constructor(entries: Readonly<Record<string, EntryOwnership>>) {
    for (const [dir, owner] of Object.entries(entries)) this.entries.set(dir, owner);
  }

  async realpath(p: string): Promise<string> {
    if (!this.entries.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return p;
  }

  async entryExists(p: string): Promise<boolean> {
    return this.entries.has(p);
  }

  async mkdirp(p: string): Promise<void> {
    for (let current = p; !this.entries.has(current); current = path.posix.dirname(current)) {
      this.entries.set(current, { uid: 1000, mode: 0o40755 });
    }
  }

  async ownership(p: string): Promise<EntryOwnership | null> {
    return this.entries.get(p) ?? null;
  }
}

describe('NodePathSandbox (POSIX shared-dir rule, fake fs)', () => {
  const root = { uid: 0, mode: 0o40755 };
  const stickyShared = { uid: 0, mode: 0o41777 };

  function make(platform: 'linux' | 'darwin', fs: FakePosixFs, home: string): NodePathSandbox {
    return new NodePathSandbox({
      protectedDirs: [],
      platform,
      homeDir: home,
      initialDownloadDir: `${home}/Downloads`,
      fs,
      uid: 1000
    });
  }

  it('linux: /tmp and 0777 mounts owned by root are shared; a 0777 dir of our own is fine', async () => {
    const fs = new FakePosixFs({
      '/': root,
      '/tmp': stickyShared,
      '/srv': root,
      '/srv/share': { uid: 0, mode: 0o40777 },
      '/srv/mine': { uid: 1000, mode: 0o40777 },
      '/home': root,
      '/home/ana': { uid: 1000, mode: 0o40700 }
    });
    const sandbox = make('linux', fs, '/home/ana');
    const reason = async (input: string): Promise<unknown> =>
      errorOf(await sandbox.validateDownloadDir(input))?.params?.['reason'];
    assert.equal(await reason('/tmp'), 'shared');
    assert.equal(await reason('/tmp/Yami'), 'shared');
    assert.equal(await reason('/srv/share/media/Yami'), 'shared');
    assert.equal(fs.entries.has('/tmp/Yami'), false, 'rejected before anything is created');
    assert.equal(await reason('/'), 'root', 'the more specific reasons still win');
    assert.ok((await sandbox.validateDownloadDir('/srv/mine/Yami')).ok);
    assert.ok((await sandbox.validateDownloadDir('/home/ana/Videos')).ok);
  });

  it('darwin: /Users/Shared is shared', async () => {
    const fs = new FakePosixFs({
      '/': root,
      '/Users': root,
      '/Users/Shared': stickyShared,
      '/Users/ana': { uid: 1000, mode: 0o40755 }
    });
    const sandbox = make('darwin', fs, '/Users/ana');
    assert.equal(errorOf(await sandbox.validateDownloadDir('/Users/Shared/Yami'))?.params?.['reason'], 'shared');
    assert.ok((await sandbox.validateDownloadDir('/Users/ana/Movies/Yami')).ok);
  });
});

/** In-memory, case-insensitive "NTFS": realpath returns the stored (canonical) casing. */
class FakeWindowsFs implements SandboxFileSystem {
  readonly entries = new Map<string, string>();
  readonly #preserveInputCase: boolean;

  constructor(paths: readonly string[], options: { preserveInputCase?: boolean } = {}) {
    this.#preserveInputCase = options.preserveInputCase ?? false;
    for (const p of paths) this.#add(p);
  }

  #add(p: string): void {
    let current = path.win32.resolve(p);
    for (;;) {
      if (!this.entries.has(current.toLowerCase())) this.entries.set(current.toLowerCase(), current);
      const parent = path.win32.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  async realpath(p: string): Promise<string> {
    const resolved = path.win32.resolve(p);
    const hit = this.entries.get(resolved.toLowerCase());
    if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return this.#preserveInputCase ? resolved : hit;
  }

  async entryExists(p: string): Promise<boolean> {
    return this.entries.has(path.win32.resolve(p).toLowerCase());
  }

  async mkdirp(p: string): Promise<void> {
    this.#add(p);
  }

  /** Must never be consulted on Windows (mode bits mean nothing there). */
  ownershipCalls = 0;
  async ownership(): Promise<EntryOwnership | null> {
    this.ownershipCalls += 1;
    return { uid: 0, mode: 0o40777 };
  }
}

describe('NodePathSandbox (win32 rules on any OS)', () => {
  const home = 'C:\\Users\\Ana';
  const dl = 'C:\\Users\\Ana\\Downloads\\Yami';
  const appData = 'C:\\Users\\Ana\\AppData\\Roaming\\Yami';
  const resources = 'C:\\Program Files\\Yami\\resources';
  const existing = [`${dl}\\clip.mp4`, appData, resources, 'C:\\Windows\\Temp', 'D:\\Data'];

  function make(fs: SandboxFileSystem, downloadDir = dl): NodePathSandbox {
    return new NodePathSandbox({
      protectedDirs: [appData, resources],
      platform: 'win32',
      homeDir: home,
      initialDownloadDir: downloadDir,
      systemRoot: 'C:\\Windows',
      fs
    });
  }

  it('compares case-insensitively and returns the canonical casing', async () => {
    const sandbox = make(new FakeWindowsFs(existing));
    assert.deepEqual(await sandbox.resolveInside('c:\\users\\ana\\downloads\\yami\\CLIP.MP4'), {
      ok: true,
      value: `${dl}\\clip.mp4`
    });
  });

  it('contains paths that differ only in case even when the fs does not canonicalize them', async () => {
    const sandbox = make(new FakeWindowsFs(existing, { preserveInputCase: true }));
    const result = await sandbox.resolveInside('C:\\USERS\\ANA\\DOWNLOADS\\YAMI\\new.mp4');
    assert.deepEqual(result, { ok: true, value: 'C:\\USERS\\ANA\\DOWNLOADS\\YAMI\\new.mp4' });
    assert.equal(errorOf(await sandbox.resolveInside('D:\\Data\\x.mp4'))?.code, ErrorCode.PATH_OUTSIDE_SANDBOX);
  });

  it('rejects protected dirs case-insensitively', async () => {
    const sandbox = make(new FakeWindowsFs(existing), 'C:\\Users\\Ana\\AppData');
    const result = await sandbox.resolveInside('c:\\users\\ana\\appdata\\roaming\\YAMI\\vault\\key.bin');
    assert.equal(errorOf(result)?.code, ErrorCode.PATH_OUTSIDE_SANDBOX);
  });

  it('rejects reserved names, ADS, device prefixes and drive-relative paths', async () => {
    const sandbox = make(new FakeWindowsFs(existing));
    for (const input of [
      `${dl}\\nul.txt`,
      `${dl}\\con\\x.mp4`,
      `${dl}\\clip.mp4:Zone.Identifier`,
      `\\\\?\\${dl}\\clip.mp4`,
      '\\\\.\\COM1',
      'C:clip.mp4',
      '\\Users\\Ana\\Downloads\\Yami\\clip.mp4'
    ]) {
      assert.equal(errorOf(await sandbox.resolveInside(input))?.code, ErrorCode.PATH_INVALID, input);
    }
  });

  it('validateDownloadDir: root, system (subfolders too), home, protected (both directions), relative', async () => {
    const sandbox = make(new FakeWindowsFs(existing));
    const reason = async (input: string): Promise<unknown> =>
      errorOf(await sandbox.validateDownloadDir(input))?.params?.['reason'];
    assert.equal(await reason('C:\\'), 'root');
    assert.equal(await reason('D:/'), 'root');
    assert.equal(await reason('c:\\windows\\temp'), 'system');
    assert.equal(await reason('C:\\Windows'), 'system');
    assert.equal(await reason('D:\\Program Files (x86)\\Media'), 'system');
    assert.equal(await reason('C:\\ProgramData\\Yami'), 'system');
    assert.equal(await reason('c:\\users\\ana'), 'home');
    assert.equal(await reason('C:\\Users\\Ana\\AppData'), 'protected');
    assert.equal(await reason('c:\\users\\ana\\appdata\\roaming\\yami\\downloads'), 'protected');
    assert.equal(await reason('Downloads'), 'relative');
    assert.equal(await reason('C:Downloads'), 'relative');
  });

  it('validateDownloadDir creates and returns an allowed directory', async () => {
    const fs = new FakeWindowsFs(existing);
    const sandbox = make(fs);
    assert.deepEqual(await sandbox.validateDownloadDir('C:\\Users\\Ana\\Videos\\Yami'), {
      ok: true,
      value: 'C:\\Users\\Ana\\Videos\\Yami'
    });
    assert.ok(fs.entries.has('c:\\users\\ana\\videos\\yami'));
    assert.deepEqual(await sandbox.validateDownloadDir('\\\\nas\\media\\Yami'), {
      ok: true,
      value: '\\\\nas\\media\\Yami'
    });
  });

  it('does not apply the POSIX shared-dir rule (ACL evaluation is out of scope)', async () => {
    const fs = new FakeWindowsFs(existing);
    const sandbox = make(fs);
    assert.deepEqual(await sandbox.validateDownloadDir('D:\\Shared\\Yami'), { ok: true, value: 'D:\\Shared\\Yami' });
    assert.equal(fs.ownershipCalls, 0);
  });

  it('honours a non-default %SystemRoot%', async () => {
    const sandbox = new NodePathSandbox({
      protectedDirs: [],
      platform: 'win32',
      homeDir: home,
      initialDownloadDir: dl,
      systemRoot: 'E:\\WinNT',
      fs: new FakeWindowsFs(existing)
    });
    assert.equal(errorOf(await sandbox.validateDownloadDir('e:\\winnt\\system32\\dl'))?.params?.['reason'], 'system');
  });
});
