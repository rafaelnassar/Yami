import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { LogFields, Logger } from '../../application/ports/system.ts';
import type { CommandOptions, CommandResult, CommandRunner } from '../process/command-runner.ts';
import type { DirectoryStats } from './path-trust.ts';
import { runtimeLayout } from './runtime-layout.ts';
import { candidatesFor, type LocationContext } from './tool-locations.ts';
import { probeEnvironment, SystemToolProbe, type ToolProbeOptions } from './tool-probe.ts';

const WIN_ENV = {
  Path: 'C:\\Windows\\system32;.;relative\\bin;"C:\\Program Files\\Tools";C:\\Tools',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  YAMI_FFMPEG: 'D:\\dev\\ffmpeg.exe'
};

function winContext(isPackaged: boolean): LocationContext {
  return {
    platform: 'win32',
    env: WIN_ENV,
    homeDir: 'C:\\Users\\u',
    isPackaged,
    layout: runtimeLayout('C:\\Users\\u\\AppData\\Local\\Yami\\runtime', 'win32')
  };
}

describe('tool locations', () => {
  it('orders managed → env (dev only) → PATH → well-known, without listing C:\\ffmpeg', () => {
    const dev = candidatesFor('ffmpeg', 'standalone', winContext(false)).map((c) => `${c.source}:${c.path}`);
    assert.deepEqual(dev, [
      'managed:C:\\Users\\u\\AppData\\Local\\Yami\\runtime\\bin\\ffmpeg.exe',
      'env:D:\\dev\\ffmpeg.exe',
      'system:C:\\Windows\\system32\\ffmpeg.exe',
      'system:C:\\Program Files\\Tools\\ffmpeg.exe',
      'system:C:\\Tools\\ffmpeg.exe',
      'system:C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
      'system:C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
    ]);
    const packaged = candidatesFor('ffmpeg', 'standalone', winContext(true));
    assert.equal(
      packaged.some((c) => c.source === 'env'),
      false
    );
    assert.equal(
      packaged.some((c) => c.path.startsWith('C:\\ffmpeg')),
      false
    );
    assert.deepEqual(candidatesFor('ffmpeg', 'standalone', winContext(true))[0]?.versionArgs, ['-version']);
  });

  it('finds Deno in ~/.deno/bin and Homebrew on macOS', () => {
    const context: LocationContext = {
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      homeDir: '/Users/u',
      isPackaged: true,
      layout: runtimeLayout('/Users/u/Library/Application Support/Yami/runtime', 'darwin')
    };
    const paths = candidatesFor('deno', 'standalone', context).map((c) => c.path);
    assert.deepEqual(paths.slice(-3), ['/Users/u/.deno/bin/deno', '/opt/homebrew/bin/deno', '/usr/local/bin/deno']);
  });

  it('treats quoted or padded POSIX PATH entries as relative (only Windows unquotes)', () => {
    const context: LocationContext = {
      platform: 'linux',
      env: { PATH: '"/opt/quoted":  /opt/padded:/usr/bin' },
      homeDir: '/home/u',
      isPackaged: true,
      layout: runtimeLayout('/home/u/.local/share/Yami/runtime', 'linux')
    };
    const system = candidatesFor('ffmpeg', 'standalone', context).filter((c) => c.source === 'system');
    assert.deepEqual(
      system.map((c) => c.path),
      ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
    );
  });

  it('runs engines as modules of the managed Python in isolated mode', () => {
    const candidates = candidatesFor('yt-dlp', 'python', winContext(true));
    assert.deepEqual(candidates, [
      {
        path: 'C:\\Users\\u\\AppData\\Local\\Yami\\runtime\\python\\python.exe',
        source: 'python',
        prefixArgs: ['-I', '-X', 'utf8', '-m', 'yt_dlp'],
        versionArgs: ['--version'],
        requireProbe: true
      }
    ]);
    assert.deepEqual(candidatesFor('python', 'python', winContext(true))[0]?.versionArgs, [
      '-I',
      '-X',
      'utf8',
      '--version'
    ]);
  });

  it('scrubs Python variables from the probe environment', () => {
    const env = probeEnvironment({ PATH: '/bin', PYTHONPATH: '/evil', pythonhome: '/x', HOME: '/h', EMPTY: undefined });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' });
  });
});

type Call = { readonly file: string; readonly args: readonly string[]; readonly options: CommandOptions };

function fakeRunner(respond: (call: Call) => Partial<CommandResult>): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    run: async (file, args, options) => {
      const call = { file, args, options };
      calls.push(call);
      return { stdout: '', stderr: '', code: 0, error: null, ...respond(call) };
    }
  };
  return { runner, calls };
}

class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: LogFields }> = [];
  debug(): void {}
  info(): void {}
  warn(message: string, fields?: LogFields): void {
    this.warnings.push({ message, ...(fields ? { fields } : {}) });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** Tools are probed in parallel, so the logged order is not deterministic. */
function sortedDirectories(logger: RecordingLogger): unknown[] {
  const directories = logger.warnings[0]?.fields?.['directories'];
  assert.ok(Array.isArray(directories));
  const list: readonly unknown[] = directories;
  return [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const scratch = mkdtempSync(path.join(tmpdir(), 'yami-probe-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SAFE_DIR: DirectoryStats = { mode: 0o40755, uid: 0 };

function linuxProbe(overrides: Partial<ToolProbeOptions>): SystemToolProbe {
  return new SystemToolProbe({
    layout: runtimeLayout('/rt', 'linux'),
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    homeDir: '/home/u',
    isPackaged: true,
    cwd: path.join(scratch, 'proc-cwd'),
    uid: 1000,
    statDir: async () => SAFE_DIR,
    ...overrides
  });
}

describe('SystemToolProbe', () => {
  it('picks the first existing candidate and reads versions in parallel, in a neutral cwd', async () => {
    const existing = new Set(['/rt/bin/yt-dlp', '/usr/bin/ffmpeg', '/usr/local/bin/deno', '/usr/bin/gallery-dl']);
    const { runner, calls } = fakeRunner((call) => {
      if (call.file === '/rt/bin/yt-dlp') return { stdout: '2025.11.12\n' };
      if (call.file === '/usr/bin/ffmpeg') return { stdout: 'ffmpeg version 7.1 Copyright\nbuilt with gcc\n' };
      if (call.file === '/usr/local/bin/deno') return { code: null, error: 'ETIMEDOUT' };
      return { code: 1, stderr: 'boom' };
    });
    const cwd = path.join(scratch, 'proc-cwd');
    const probe = linuxProbe({ runner, cwd, isFile: async (file) => existing.has(file) });
    const snapshot = await probe.probe('standalone');
    assert.equal(snapshot.managedBinDir, '/rt/bin');
    assert.deepEqual(snapshot.tools['yt-dlp'], {
      path: '/rt/bin/yt-dlp',
      directory: '/rt/bin',
      source: 'managed',
      rawVersion: '2025.11.12',
      prefixArgs: []
    });
    assert.equal(snapshot.tools.ffmpeg?.rawVersion, 'ffmpeg version 7.1 Copyright');
    assert.deepEqual(
      [snapshot.tools.deno?.source, snapshot.tools.deno?.rawVersion],
      ['system', null],
      'a slow binary still counts as installed'
    );
    assert.equal(snapshot.tools['gallery-dl']?.rawVersion, null);
    assert.equal(snapshot.tools.python, null);
    assert.deepEqual(calls.find((c) => c.file === '/usr/bin/ffmpeg')?.args, ['-version']);
    assert.ok(calls.every((c) => c.options.timeoutMs === 5_000));
    assert.ok(
      calls.every((c) => c.options.cwd === cwd),
      'probes never inherit the host cwd'
    );
    assert.equal(statSync(cwd).isDirectory(), true, 'the neutral cwd is created when missing');
  });

  it('counts a python-mode engine only when its module imports, running Python isolated', async () => {
    const { runner, calls } = fakeRunner((call) =>
      call.args.includes('gallery_dl')
        ? { code: 1, stderr: 'No module named gallery_dl' }
        : { stdout: call.args.includes('yt_dlp') ? '2025.11.12' : 'Python 3.12.14' }
    );
    const probe = linuxProbe({ env: {}, runner, isFile: async (file) => file === '/rt/python/bin/python3' });
    const snapshot = await probe.probe('python');
    assert.equal(snapshot.tools['gallery-dl'], null);
    assert.deepEqual(snapshot.tools['yt-dlp']?.prefixArgs, ['-I', '-X', 'utf8', '-m', 'yt_dlp']);
    assert.equal(snapshot.tools['yt-dlp']?.source, 'python');
    assert.equal(snapshot.tools.python?.rawVersion, 'Python 3.12.14');
    assert.ok(calls.length > 0 && calls.every((c) => c.args[0] === '-I'), 'every Python probe runs with -I');
  });

  it('never runs tools from world-writable or foreign-owned PATH directories (POSIX) and logs them once', async () => {
    const stats: Record<string, DirectoryStats> = {
      '/tmp/evil': { mode: 0o41777, uid: 0 },
      '/home/other/bin': { mode: 0o40755, uid: 1001 },
      '/home/u/bin': { mode: 0o40755, uid: 1000 },
      '/usr/bin': SAFE_DIR
    };
    const logger = new RecordingLogger();
    const { runner, calls } = fakeRunner(() => ({ stdout: 'v1' }));
    const probe = linuxProbe({
      env: { PATH: '/tmp/evil:/home/other/bin:/home/u/bin:/usr/bin' },
      runner,
      logger,
      statDir: async (dir) => stats[dir] ?? null,
      isFile: async (file) =>
        ['/tmp/evil/ffmpeg', '/home/other/bin/deno', '/home/u/bin/deno', '/usr/bin/ffmpeg'].includes(file)
    });
    const snapshot = await probe.probe('standalone');
    assert.equal(snapshot.tools.ffmpeg?.path, '/usr/bin/ffmpeg');
    assert.equal(snapshot.tools.deno?.path, '/home/u/bin/deno');
    assert.equal(
      calls.some((c) => c.file.startsWith('/tmp/evil') || c.file.startsWith('/home/other')),
      false
    );
    assert.equal(logger.warnings.length, 1);
    assert.deepEqual(sortedDirectories(logger), [
      { directory: '/home/other/bin', reason: 'foreign-owner' },
      { directory: '/tmp/evil', reason: 'world-writable' }
    ]);
    await probe.probe('standalone');
    assert.equal(logger.warnings.length, 1, 'already reported directories are not logged again');
  });

  it('only trusts Windows PATH directories under protected or per-user roots', async () => {
    const env = {
      PATH: 'C:\\Tools;C:\\WINDOWS\\System32;C:\\Program Files\\Tools;C:\\Windows\\..\\evil;c:/users/U/bin/',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\Users\\u',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
    };
    const existing = new Set([
      'C:\\Tools\\ffmpeg.exe',
      'C:\\Program Files\\Tools\\ffmpeg.exe',
      'C:\\evil\\deno.exe',
      'c:\\users\\U\\bin\\deno.exe'
    ]);
    const logger = new RecordingLogger();
    const { runner, calls } = fakeRunner(() => ({ stdout: 'v1' }));
    const probe = new SystemToolProbe({
      layout: runtimeLayout('C:\\Users\\u\\AppData\\Local\\Yami\\runtime', 'win32'),
      platform: 'win32',
      env,
      homeDir: 'C:\\Users\\u',
      isPackaged: true,
      cwd: path.join(scratch, 'win-cwd'),
      runner,
      logger,
      isFile: async (file) => existing.has(file)
    });
    const snapshot = await probe.probe('standalone');
    assert.equal(snapshot.tools.ffmpeg?.path, 'C:\\Program Files\\Tools\\ffmpeg.exe');
    assert.equal(snapshot.tools.deno?.path, 'c:\\users\\U\\bin\\deno.exe', 'roots match case-insensitively');
    assert.deepEqual(calls.map((c) => c.file).sort(), [
      'C:\\Program Files\\Tools\\ffmpeg.exe',
      'c:\\users\\U\\bin\\deno.exe'
    ]);
    assert.deepEqual(sortedDirectories(logger), [
      { directory: 'C:\\evil', reason: 'outside-trusted-roots' },
      { directory: 'C:\\Tools', reason: 'outside-trusted-roots' }
    ]);
  });
});
