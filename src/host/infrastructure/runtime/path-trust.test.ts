import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DirectoryTrust, isUnderWindowsRoot, windowsTrustedRoots } from './path-trust.ts';

const WIN_ENV = {
  SYSTEMROOT: 'C:\\WINDOWS',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  USERPROFILE: 'C:\\Users\\u'
};

describe('windows trusted roots', () => {
  it('resolves the protected and per-user roots from the environment, case-insensitively', () => {
    assert.deepEqual(windowsTrustedRoots(WIN_ENV, 'C:\\Users\\u'), [
      'c:\\windows',
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\programdata\\chocolatey\\bin',
      'c:\\users\\u\\appdata\\local',
      'c:\\users\\u\\appdata\\roaming',
      'c:\\users\\u'
    ]);
  });

  it('falls back to the home directory and never trusts a drive root or a relative value', () => {
    assert.deepEqual(
      windowsTrustedRoots({ SystemRoot: 'C:\\', ProgramFiles: 'Program Files', LOCALAPPDATA: '' }, 'D:\\Home\\u'),
      ['d:\\home\\u']
    );
  });

  it('matches directories under a root, not siblings sharing a prefix or `..` escapes', () => {
    const roots = windowsTrustedRoots(WIN_ENV, 'C:\\Users\\u');
    for (const dir of [
      'C:\\Windows\\System32',
      'c:/program files/Git/cmd/',
      'C:\\ProgramData\\chocolatey\\bin',
      'C:\\Users\\u\\.deno\\bin'
    ]) {
      assert.equal(isUnderWindowsRoot(dir, roots), true, dir);
    }
    for (const dir of [
      'C:\\Tools',
      'C:\\ffmpeg\\bin',
      'C:\\ProgramData\\evil',
      'C:\\Windows2',
      'C:\\Users\\uu\\bin',
      'C:\\Windows\\..\\evil',
      'D:\\Windows'
    ]) {
      assert.equal(isUnderWindowsRoot(dir, roots), false, dir);
    }
  });

  it('checks Windows directories without touching the filesystem', async () => {
    const trust = new DirectoryTrust({
      platform: 'win32',
      env: WIN_ENV,
      homeDir: 'C:\\Users\\u',
      uid: null,
      statDir: () => Promise.reject(new Error('no stat on Windows'))
    });
    assert.equal(await trust.check('C:\\Program Files\\ffmpeg\\bin'), null);
    assert.equal(await trust.check('C:\\Tools'), 'outside-trusted-roots');
  });
});

describe('POSIX directory trust', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'yami-trust-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('rejects world-writable and foreign-owned directories (injected stats)', async () => {
    const stats: Record<string, { mode: number; uid: number }> = {
      '/usr/bin': { mode: 0o40755, uid: 0 },
      '/home/u/bin': { mode: 0o40700, uid: 1000 },
      '/tmp': { mode: 0o41777, uid: 0 },
      '/opt/shared': { mode: 0o40775, uid: 1001 }
    };
    const trust = new DirectoryTrust({
      platform: 'darwin',
      env: {},
      homeDir: '/home/u',
      uid: 1000,
      statDir: async (d) => stats[d] ?? null
    });
    assert.equal(await trust.check('/usr/bin'), null);
    assert.equal(await trust.check('/home/u/bin'), null);
    assert.equal(await trust.check('/tmp'), 'world-writable');
    assert.equal(await trust.check('/opt/shared'), 'foreign-owner');
    assert.equal(await trust.check('/nope'), 'missing');
    const rootOnly = new DirectoryTrust({
      platform: 'linux',
      env: {},
      homeDir: '/home/u',
      uid: null,
      statDir: async (d) => stats[d] ?? null
    });
    assert.equal(await rootOnly.check('/home/u/bin'), 'foreign-owner');
  });

  it('reads real directory modes', { skip: process.platform === 'win32' }, async () => {
    const uid = process.getuid?.() ?? null;
    const trust = new DirectoryTrust({ platform: 'linux', env: {}, homeDir: root, uid });
    const safe = path.join(root, 'safe');
    const open = path.join(root, 'open');
    mkdirSync(safe, { mode: 0o755 });
    mkdirSync(open);
    chmodSync(open, 0o777);
    assert.equal(await trust.check(safe), null);
    assert.equal(await trust.check(open), 'world-writable');
    assert.equal(await trust.check(path.join(root, 'missing')), 'missing');
  });
});
