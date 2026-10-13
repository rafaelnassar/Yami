import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { InstalledToolMeta } from '../../application/runtime/ports.ts';
import { runtimeLayout } from './runtime-layout.ts';
import { ManagedToolInstaller } from './tool-installer.ts';

const base = mkdtempSync(path.join(tmpdir(), 'yami-install-'));
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function setup() {
  counter += 1;
  const layout = runtimeLayout(path.join(base, `rt-${counter}`), 'linux');
  return { layout, installer: new ManagedToolInstaller(layout) };
}

function meta(tool: InstalledToolMeta['tool'], version: string): InstalledToolMeta {
  return { tool, version, sha256: 'a'.repeat(64), source: 'https://example.test/x', installedAt: 1 };
}

describe('ManagedToolInstaller', () => {
  it('prepares the layout and removes leftovers of interrupted runs', async () => {
    const { layout, installer } = setup();
    mkdirSync(path.join(layout.tmpDir, 'old-extract'), { recursive: true });
    mkdirSync(layout.binDir, { recursive: true });
    writeFileSync(path.join(layout.binDir, 'yt-dlp.1234.new'), 'x');
    writeFileSync(path.join(layout.binDir, 'yt-dlp'), 'keep');
    mkdirSync(path.join(layout.root, 'python.old-abcd'), { recursive: true });
    await installer.prepare();
    assert.deepEqual(readdirSync(layout.tmpDir), []);
    assert.deepEqual(readdirSync(layout.binDir), ['yt-dlp']);
    assert.equal(existsSync(path.join(layout.root, 'python.old-abcd')), false);
  });

  it('installs a single-file download atomically with metadata', async () => {
    const { layout, installer } = setup();
    await installer.prepare();
    const staging = await installer.stage('yt-dlp');
    writeFileSync(staging.downloadPath, 'v1');
    const first = await installer.installExecutable({
      tool: 'yt-dlp',
      staging,
      entry: null,
      companions: {},
      meta: meta('yt-dlp', '2025.11.12')
    });
    assert.ok(first.ok);
    // The layout is built for `linux` (POSIX separators) on every host: compare normalized paths.
    assert.equal(path.normalize(first.value.path), path.normalize(path.join(layout.binDir, 'yt-dlp')));
    assert.equal(readFileSync(first.value.path, 'utf8'), 'v1');
    if (process.platform !== 'win32') assert.equal(statSync(first.value.path).mode & 0o777, 0o755);
    assert.deepEqual(await installer.readMeta('yt-dlp'), meta('yt-dlp', '2025.11.12'));

    const next = await installer.stage('yt-dlp');
    writeFileSync(next.downloadPath, 'v2');
    assert.ok(
      (
        await installer.installExecutable({
          tool: 'yt-dlp',
          staging: next,
          entry: null,
          companions: {},
          meta: meta('yt-dlp', '2026.01.01')
        })
      ).ok
    );
    assert.equal(readFileSync(first.value.path, 'utf8'), 'v2');
    assert.equal((await installer.readMeta('yt-dlp'))?.version, '2026.01.01');
    assert.deepEqual(readdirSync(layout.binDir).sort(), ['.yt-dlp.json', 'yt-dlp']);
    await installer.release(next);
  });

  it('installs an archive entry with companions and refuses escaping entries', async () => {
    const { layout, installer } = setup();
    const staging = await installer.stage('ffmpeg');
    mkdirSync(path.join(staging.extractDir, 'ffmpeg-7.1.1', 'bin'), { recursive: true });
    writeFileSync(path.join(staging.extractDir, 'ffmpeg-7.1.1', 'bin', 'ffmpeg'), 'ff');
    writeFileSync(path.join(staging.extractDir, 'ffmpeg-7.1.1', 'bin', 'ffprobe'), 'fp');
    const result = await installer.installExecutable({
      tool: 'ffmpeg',
      staging,
      entry: 'ffmpeg-7.1.1/bin/ffmpeg',
      companions: { ffprobe: 'ffmpeg-7.1.1/bin/ffprobe' },
      meta: meta('ffmpeg', '7.1.1')
    });
    assert.ok(result.ok);
    assert.equal(readFileSync(layout.binPath('ffprobe'), 'utf8'), 'fp');

    const escape = await installer.installExecutable({
      tool: 'deno',
      staging,
      entry: '../deno',
      companions: {},
      meta: meta('deno', '1')
    });
    assert.equal(escape.ok ? null : escape.error.code, ErrorCode.TOOLS_INSTALL_FAILED);
    const missing = await installer.installExecutable({
      tool: 'deno',
      staging,
      entry: 'deno',
      companions: {},
      meta: meta('deno', '1')
    });
    assert.equal(missing.ok, false);
    await installer.release(staging);
    assert.equal(existsSync(staging.extractDir), false);
  });

  it('reports a replacement failure instead of leaving temp files', async () => {
    const { layout, installer } = setup();
    mkdirSync(path.join(layout.binDir, 'deno', 'busy'), { recursive: true }); // a non-empty dir cannot be replaced by a file
    const staging = await installer.stage('deno');
    writeFileSync(staging.downloadPath, 'deno');
    const result = await installer.installExecutable({
      tool: 'deno',
      staging,
      entry: null,
      companions: {},
      meta: meta('deno', '2.5.6')
    });
    assert.equal(result.ok ? null : result.error.code, ErrorCode.TOOLS_INSTALL_FAILED);
    assert.deepEqual(readdirSync(layout.binDir), ['deno']);
  });

  it('replaces the managed Python distribution', async () => {
    const { layout, installer } = setup();
    for (const version of ['3.12.13', '3.12.14']) {
      const staging = await installer.stage('python');
      mkdirSync(path.join(staging.extractDir, 'python', 'bin'), { recursive: true });
      writeFileSync(path.join(staging.extractDir, 'python', 'bin', 'python3'), version);
      const result = await installer.installPython({
        staging,
        entry: 'python/bin/python3',
        meta: meta('python', version)
      });
      assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
      assert.equal(result.value.executable, layout.pythonExecutable);
      await installer.release(staging);
    }
    assert.equal(readFileSync(layout.pythonExecutable, 'utf8'), '3.12.14');
    assert.equal((await installer.readMeta('python'))?.version, '3.12.14');
    assert.deepEqual(
      readdirSync(layout.root).filter((n) => n.startsWith('python')),
      ['python']
    );

    const empty = await installer.stage('python');
    mkdirSync(empty.extractDir, { recursive: true });
    const missing = await installer.installPython({
      staging: empty,
      entry: 'python/bin/python3',
      meta: meta('python', '9')
    });
    assert.equal(missing.ok, false);
    assert.equal(readFileSync(layout.pythonExecutable, 'utf8'), '3.12.14', 'previous install untouched');
  });

  it('prepares the staged Python before swapping it in, and keeps the current one when that fails', async () => {
    const { layout, installer } = setup();
    const install = async (version: string, beforeSwap: (staged: string) => Promise<Result<void, AppErrorData>>) => {
      const staging = await installer.stage('python');
      mkdirSync(path.join(staging.extractDir, 'python', 'bin'), { recursive: true });
      writeFileSync(path.join(staging.extractDir, 'python', 'bin', 'python3'), version);
      const result = await installer.installPython({
        staging,
        entry: 'python/bin/python3',
        meta: meta('python', version),
        beforeSwap
      });
      await installer.release(staging);
      return result;
    };
    const seen: string[] = [];
    const first = await install('3.12.13', async (staged) => {
      seen.push(staged);
      // e.g. pip installing the engines into the staged distribution
      writeFileSync(path.join(path.dirname(staged), 'site-marker'), 'engines');
      return ok();
    });
    assert.ok(first.ok);
    assert.ok(
      path.normalize(seen[0] ?? '').startsWith(`${path.normalize(layout.tmpDir)}${path.sep}`),
      'runs on the staged copy, not the installed one'
    );
    assert.equal(
      readFileSync(path.join(layout.pythonDir, 'bin', 'site-marker'), 'utf8'),
      'engines',
      'packages move with it'
    );

    const failure = { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'pip' } };
    const failed = await install('3.12.14', async () => err(failure));
    assert.deepEqual(failed.ok ? null : failed.error, failure);
    assert.equal(readFileSync(layout.pythonExecutable, 'utf8'), '3.12.13', 'current Python and its packages kept');
    assert.equal(readFileSync(path.join(layout.pythonDir, 'bin', 'site-marker'), 'utf8'), 'engines');
    assert.equal((await installer.readMeta('python'))?.version, '3.12.13');
  });

  it('ignores unreadable or foreign metadata', async () => {
    const { layout, installer } = setup();
    mkdirSync(layout.binDir, { recursive: true });
    writeFileSync(layout.metaPath('deno'), '{ not json');
    writeFileSync(layout.metaPath('ffmpeg'), JSON.stringify(meta('deno', '1')));
    assert.equal(await installer.readMeta('deno'), null);
    assert.equal(await installer.readMeta('ffmpeg'), null);
    assert.equal(await installer.readMeta('python'), null);
  });
});

describe('runtimeLayout', () => {
  it('builds Windows paths on any host', () => {
    const layout = runtimeLayout('C:\\Users\\u\\AppData\\Local\\Yami\\runtime', 'win32');
    assert.equal(layout.binPath('yt-dlp'), 'C:\\Users\\u\\AppData\\Local\\Yami\\runtime\\bin\\yt-dlp.exe');
    assert.equal(layout.pythonExecutable, 'C:\\Users\\u\\AppData\\Local\\Yami\\runtime\\python\\python.exe');
    assert.equal(layout.metaPath('deno'), 'C:\\Users\\u\\AppData\\Local\\Yami\\runtime\\bin\\.deno.json');
  });
});
