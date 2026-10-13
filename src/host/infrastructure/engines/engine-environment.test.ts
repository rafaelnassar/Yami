import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureLogger } from '../persistence/test-fixtures.ts';
import { DirectoryTrust, type DirectoryStats } from '../runtime/path-trust.ts';
import { ScrubbedEngineEnvironment, mergePathEntries, type PathDirectoryTrust } from './engine-environment.ts';

const TRUST_ALL: PathDirectoryTrust = { check: async () => null };

describe('ScrubbedEngineEnvironment (POSIX)', () => {
  const source = {
    PATH: '/usr/local/bin:/usr/bin:/opt/yami/bin/',
    HOME: '/home/u',
    HTTPS_PROXY: 'http://proxy:8080',
    PYTHONPATH: '/evil',
    PYTHONHOME: '/evil',
    PYTHONSTARTUP: '/evil/start.py',
    PYTHONINSPECT: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONLEGACYWINDOWSSTDIO: '1',
    PYTHONIOENCODING: 'latin-1',
    GALLERY_DL_CONFIG: '/c',
    GALLERYDL_CONFIG: '/c',
    YTDLP_CONFIG: '/c',
    YT_DL_CONFIG: '/c',
    NODE_OPTIONS: '--require /evil.js',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    YAMI_DATA_DIR: '/home/u/.yami',
    UNDEFINED_VALUE: undefined
  };

  it('removes hijacking and host-internal variables but keeps the rest', async () => {
    const env = await new ScrubbedEngineEnvironment(source, 'linux', TRUST_ALL).base([]);
    for (const name of [
      'PYTHONPATH',
      'PYTHONHOME',
      'PYTHONSTARTUP',
      'PYTHONINSPECT',
      'PYTHONNOUSERSITE',
      'PYTHONLEGACYWINDOWSSTDIO',
      'GALLERY_DL_CONFIG',
      'GALLERYDL_CONFIG',
      'YTDLP_CONFIG',
      'YT_DL_CONFIG',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_NO_ATTACH_CONSOLE',
      'YAMI_DATA_DIR',
      'UNDEFINED_VALUE'
    ]) {
      assert.equal(name in env, false, name);
    }
    assert.equal(env['HOME'], '/home/u');
    assert.equal(env['HTTPS_PROXY'], 'http://proxy:8080');
  });

  it('forces UTF-8 Python stdio (Q3)', async () => {
    const env = await new ScrubbedEngineEnvironment(source, 'linux', TRUST_ALL).base([]);
    assert.equal(env['PYTHONUTF8'], '1');
    assert.equal(env['PYTHONIOENCODING'], 'utf-8');
  });

  it('prepends tool dirs in order and de-duplicates entries', async () => {
    const env = await new ScrubbedEngineEnvironment(source, 'linux', TRUST_ALL).base([
      '/opt/yami/bin',
      '/opt/deno',
      '',
      '/opt/deno/'
    ]);
    assert.equal(env['PATH'], '/opt/yami/bin:/opt/deno:/usr/local/bin:/usr/bin');
  });

  it('creates PATH when the host has none', async () => {
    const env = await new ScrubbedEngineEnvironment({}, 'darwin', TRUST_ALL).base(['/opt/yami/bin']);
    assert.equal(env['PATH'], '/opt/yami/bin');
  });

  it('does not mutate the source environment', async () => {
    const original = { PATH: '/usr/bin', PYTHONPATH: '/x' };
    await new ScrubbedEngineEnvironment(original, 'linux', TRUST_ALL).base(['/opt/bin']);
    assert.deepEqual(original, { PATH: '/usr/bin', PYTHONPATH: '/x' });
  });

  it('keeps only PATH entries that pass the directory trust policy (tool dirs are kept as given)', async () => {
    const stats: Record<string, DirectoryStats> = {
      '/usr/bin': { mode: 0o40755, uid: 0 },
      '/home/u/.local/bin': { mode: 0o40755, uid: 1000 },
      '/tmp/evil': { mode: 0o41777, uid: 0 },
      '/home/other/bin': { mode: 0o40755, uid: 1001 }
    };
    const trust = new DirectoryTrust({
      platform: 'linux',
      env: {},
      homeDir: '/home/u',
      uid: 1000,
      statDir: async (d) => stats[d] ?? null
    });
    const { logger, entries } = captureLogger();
    const environment = new ScrubbedEngineEnvironment(
      { PATH: '/tmp/evil:/usr/bin:.:bin:/home/other/bin:/gone:/home/u/.local/bin' },
      'linux',
      trust,
      logger
    );
    const env = await environment.base(['/opt/yami/bin']);
    assert.equal(env['PATH'], '/opt/yami/bin:/usr/bin:/home/u/.local/bin');
    const warnings = entries.filter((e) => e.level === 'warn');
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0]?.fields?.['directories'], [
      { directory: '/tmp/evil', reason: 'world-writable' },
      { directory: '.', reason: 'relative' },
      { directory: 'bin', reason: 'relative' },
      { directory: '/home/other/bin', reason: 'foreign-owner' }
    ]);
    await environment.base([]);
    assert.equal(entries.filter((e) => e.level === 'warn').length, 1, 'each dropped directory is logged once');
  });

  it('keeps the OS binary dirs of a user-namespace sandbox (root shown as nobody), unless world-writable', async () => {
    const nobody = 65534;
    const stats: Record<string, DirectoryStats> = {
      '/usr/local/bin': { mode: 0o40755, uid: nobody },
      '/usr/bin/': { mode: 0o40755, uid: nobody },
      '/bin': { mode: 0o40755, uid: nobody },
      '/sbin': { mode: 0o40777, uid: nobody }
    };
    const statDir = async (d: string) => stats[d] ?? null;
    const trust = new DirectoryTrust({ platform: 'linux', env: {}, homeDir: '/home/u', uid: 1000, statDir });
    const source = { PATH: '/usr/local/bin:/usr/bin/:/bin:/sbin' };
    const env = await new ScrubbedEngineEnvironment(source, 'linux', trust).base([]);
    assert.equal(env['PATH'], '/usr/bin/:/bin');
  });

  it('does not unquote or trim POSIX entries (they are relative there)', async () => {
    const checked: string[] = [];
    const recording: PathDirectoryTrust = { check: async (d) => (checked.push(d), null) };
    const source = { PATH: '"/usr/local/bin": /opt/x:/usr/bin' };
    const env = await new ScrubbedEngineEnvironment(source, 'linux', recording).base([]);
    assert.equal(env['PATH'], '/usr/bin');
    assert.deepEqual(checked, ['/usr/bin']);
  });

  it('drops an entry whose trust check fails', async () => {
    const failing: PathDirectoryTrust = {
      check: async (d) => (d === '/boom' ? Promise.reject(new Error('EIO')) : null)
    };
    const env = await new ScrubbedEngineEnvironment({ PATH: '/boom:/usr/bin' }, 'linux', failing).base([]);
    assert.equal(env['PATH'], '/usr/bin');
  });
});

describe('ScrubbedEngineEnvironment (win32, Q5)', () => {
  it('keeps the existing Path casing instead of creating a second PATH', async () => {
    const env = await new ScrubbedEngineEnvironment(
      { Path: 'C:\\Windows\\system32;C:\\Windows', SystemRoot: 'C:\\Windows' },
      'win32',
      TRUST_ALL
    ).base(['C:\\Users\\U\\AppData\\Local\\Yami\\runtime\\bin']);
    assert.equal(env['Path'], 'C:\\Users\\U\\AppData\\Local\\Yami\\runtime\\bin;C:\\Windows\\system32;C:\\Windows');
    assert.equal('PATH' in env, false);
    assert.equal(env['SystemRoot'], 'C:\\Windows');
  });

  it('merges case-variant PATH duplicates into one key', async () => {
    const merged = new ScrubbedEngineEnvironment({ Path: 'C:\\A', PATH: 'C:\\B;c:\\a\\' }, 'win32', TRUST_ALL);
    const env = await merged.base([]);
    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
    assert.deepEqual(pathKeys, ['Path']);
    assert.equal(env['Path'], 'C:\\A;C:\\B');
  });

  it('de-duplicates entries case-insensitively and with either separator', async () => {
    const env = await new ScrubbedEngineEnvironment(
      { Path: 'c:\\tools\\FFMPEG\\bin\\;C:\\Windows' },
      'win32',
      TRUST_ALL
    ).base(['C:\\Tools\\ffmpeg\\bin', 'C:/Tools/ffmpeg/bin']);
    assert.equal(env['Path'], 'C:\\Tools\\ffmpeg\\bin;C:\\Windows');
  });

  it('drops PATH folders other local users can write to (C:\\ffmpeg\\bin) but keeps system and user dirs', async () => {
    const source = {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\U\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\U',
      Path: [
        'C:\\ffmpeg\\bin',
        'C:\\Windows\\System32',
        '"C:\\Program Files\\Git\\cmd"',
        'C:\\Users\\U\\AppData\\Local\\Microsoft\\WindowsApps',
        'D:\\tools',
        '\\\\server\\share\\bin',
        'C:\\Windows'
      ].join(';')
    };
    const trust = new DirectoryTrust({ platform: 'win32', env: source, homeDir: 'C:\\Users\\U', uid: null });
    const env = await new ScrubbedEngineEnvironment(source, 'win32', trust).base([
      'C:\\Users\\U\\AppData\\Local\\Yami\\runtime\\bin'
    ]);
    assert.equal(
      env['Path'],
      [
        'C:\\Users\\U\\AppData\\Local\\Yami\\runtime\\bin',
        'C:\\Windows\\System32',
        '"C:\\Program Files\\Git\\cmd"',
        'C:\\Users\\U\\AppData\\Local\\Microsoft\\WindowsApps',
        'C:\\Windows'
      ].join(';')
    );
  });

  it('scrubs variables regardless of their casing', async () => {
    const env = await new ScrubbedEngineEnvironment(
      { PythonPath: 'C:\\evil', Electron_Run_As_Node: '1', pythonioencoding: 'cp1252', LOCALAPPDATA: 'C:\\L' },
      'win32',
      TRUST_ALL
    ).base([]);
    assert.equal('PythonPath' in env, false);
    assert.equal('Electron_Run_As_Node' in env, false);
    assert.equal('pythonioencoding' in env, false);
    assert.equal(env['PYTHONIOENCODING'], 'utf-8');
    assert.equal(env['LOCALAPPDATA'], 'C:\\L');
  });
});

describe('mergePathEntries', () => {
  it('keeps POSIX entries case-sensitive', () => {
    assert.deepEqual(mergePathEntries(['/Opt/bin'], ['/opt/bin', '/'], false), ['/Opt/bin', '/opt/bin', '/']);
  });
});
