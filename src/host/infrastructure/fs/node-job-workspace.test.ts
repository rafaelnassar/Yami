import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError } from '../../../shared/kernel/errors.ts';
import type { Logger, LogFields } from '../../application/ports/system.ts';
import { NodeJobWorkspace } from './node-job-workspace.ts';

const isPosix = process.platform !== 'win32';

class RecordingLogger implements Logger {
  readonly entries: { level: string; message: string; fields: LogFields | undefined }[] = [];
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields });
  }
  child(): Logger {
    return this;
  }
}

describe('NodeJobWorkspace', () => {
  let dataDir = '';
  let workspace: NodeJobWorkspace;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'yami-ws-'));
    workspace = new NodeJobWorkspace({ dataDir });
  });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  it('prepares a private work dir, a temp dir, the log path and the neutral cwd', async () => {
    const paths = await workspace.prepare('dl_123-abc');
    assert.deepEqual(paths, {
      dir: path.join(dataDir, 'work', 'dl_123-abc'),
      logFile: path.join(dataDir, 'jobs', 'dl_123-abc.log'),
      tempDir: path.join(dataDir, 'work', 'dl_123-abc', 'tmp')
    });
    assert.equal(workspace.processCwd, path.join(dataDir, 'proc-cwd'));
    assert.equal((await stat(workspace.processCwd)).isDirectory(), true);
    assert.equal((await stat(path.join(dataDir, 'jobs'))).isDirectory(), true);
    if (isPosix) {
      assert.equal((await stat(paths.dir)).mode & 0o777, 0o700);
      assert.equal((await stat(paths.tempDir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(dataDir, 'work'))).mode & 0o777, 0o700);
    }
  });

  it('writes private files atomically with 0600 permissions', async () => {
    await workspace.prepare('job1');
    const file = await workspace.writePrivateFile('job1', 'cookies.txt', '# Netscape\nsecret');
    assert.equal(file, path.join(dataDir, 'work', 'job1', 'cookies.txt'));
    assert.equal(await readFile(file, 'utf8'), '# Netscape\nsecret');
    if (isPosix) assert.equal((await stat(file)).mode & 0o777, 0o600);
    await workspace.writePrivateFile('job1', 'cookies.txt', 'v2');
    assert.equal(await readFile(file, 'utf8'), 'v2');
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ['cookies.txt', 'tmp'], 'no temp leftovers');
  });

  it('rejects unsafe ids and file names', async () => {
    for (const id of ['../x', 'a/b', '', 'a b', 'a.b']) {
      await assert.rejects(() => workspace.prepare(id), AppError, id);
    }
    for (const name of ['../evil', '.hidden', 'a/b', '', 'x\\y']) {
      await assert.rejects(() => workspace.writePrivateFile('job1', name, 'x'), AppError, name);
    }
  });

  it('cleanup removes the work dir and keeps the log unless removeLog', async () => {
    const paths = await workspace.prepare('job2');
    await writeFile(paths.logFile, 'log');
    await workspace.writePrivateFile('job2', 'config.json', '{}');
    await writeFile(path.join(paths.tempDir, 'video.mp4.part'), 'partial');
    await workspace.cleanup('job2');
    await assert.rejects(() => stat(paths.dir));
    assert.equal(await readFile(paths.logFile, 'utf8'), 'log');
    await workspace.cleanup('job2', { removeLog: true });
    await assert.rejects(() => stat(paths.logFile));
    await workspace.cleanup('never-prepared', { removeLog: true });
  });

  it('removeSecrets removes the cookie snapshot and engine config but keeps partial files and the log', async () => {
    const paths = await workspace.prepare('job3');
    await writeFile(paths.logFile, 'log');
    await workspace.writePrivateFile('job3', 'cookies.txt', 'secret');
    await workspace.writePrivateFile('job3', 'gallery-dl.json', '{"refresh-token":"t"}');
    await mkdir(path.join(paths.dir, 'stray-dir'));
    await writeFile(path.join(paths.tempDir, 'video.f137.mp4.part'), 'partial');
    await mkdir(path.join(paths.tempDir, 'fragments'));
    await writeFile(path.join(paths.tempDir, 'fragments', 'Frag1'), 'frag');
    await workspace.removeSecrets('job3');
    assert.deepEqual(await readdir(paths.dir), ['tmp']);
    assert.equal(await readFile(path.join(paths.tempDir, 'video.f137.mp4.part'), 'utf8'), 'partial');
    assert.equal(await readFile(path.join(paths.tempDir, 'fragments', 'Frag1'), 'utf8'), 'frag');
    assert.equal(await readFile(paths.logFile, 'utf8'), 'log');
    // The next run of the same download continues in the same temp dir.
    assert.deepEqual(await workspace.prepare('job3'), paths);
    assert.equal(await readFile(path.join(paths.tempDir, 'video.f137.mp4.part'), 'utf8'), 'partial');
    await workspace.removeSecrets('never-prepared');
    await assert.rejects(() => workspace.removeSecrets('../x'), AppError);
  });

  it('removeSecrets never keeps a `tmp` entry that is not a real directory', async () => {
    const paths = await workspace.prepare('job4');
    const outside = path.join(dataDir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'precious.txt'), 'keep me');
    await rm(paths.tempDir, { recursive: true });
    await symlink(outside, paths.tempDir, 'junction');
    await workspace.removeSecrets('job4');
    assert.deepEqual(await readdir(paths.dir), []);
    assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', 'the link is not followed');
  });

  it('removeSecrets on a job dir replaced by a link removes the link only (never lists its target)', async () => {
    await workspace.initialize();
    const outside = path.join(dataDir, 'outside');
    await mkdir(path.join(outside, 'tmp'), { recursive: true });
    await writeFile(path.join(outside, 'precious.txt'), 'keep me');
    await symlink(outside, path.join(dataDir, 'work', 'job7'), 'junction');
    await workspace.removeSecrets('job7');
    assert.deepEqual(await readdir(path.join(dataDir, 'work')), []);
    assert.deepEqual((await readdir(outside)).sort(), ['precious.txt', 'tmp']);
    assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
  });

  it('cleanup compacts a big log (head + marker + tail, on line boundaries) and leaves small ones alone', async () => {
    const small = new NodeJobWorkspace({ dataDir, logCompaction: { headBytes: 16, tailBytes: 16 } });
    const paths = await small.prepare('job5');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')}`);
    await writeFile(paths.logFile, `${lines.join('\n')}\n`);
    await small.cleanup('job5');
    const compacted = await readFile(paths.logFile, 'utf8');
    const kept = compacted.split('\n');
    assert.deepEqual(kept.slice(0, 2), ['line 00', 'line 01']);
    assert.match(kept[2] ?? '', /^\[yami\] \.\.\. \d+ bytes of engine output omitted/);
    assert.deepEqual(kept.slice(3), ['line 48', 'line 49', '']);
    assert.deepEqual(await readdir(path.dirname(paths.logFile)), ['job5.log'], 'no temp leftovers');
    if (isPosix) assert.equal((await stat(paths.logFile)).mode & 0o777, 0o600);

    await writeFile(paths.logFile, 'short log\n');
    await small.cleanup('job5');
    assert.equal(await readFile(paths.logFile, 'utf8'), 'short log\n');
  });

  it('a failing log compaction is logged and keeps the log', async () => {
    const logger = new RecordingLogger();
    const ws = new NodeJobWorkspace({ dataDir, logger, logCompaction: { headBytes: 1, tailBytes: 1 } });
    const paths = await ws.prepare('job6');
    await mkdir(paths.logFile); // not a readable file
    await ws.cleanup('job6');
    assert.equal((await stat(paths.logFile)).isDirectory(), true);
    assert.equal(logger.entries.filter((entry) => entry.message === 'job log compaction failed').length, 1);
  });

  describe('sweep', () => {
    it('removes every job dir neither in use nor resumable (secrets included) and keeps the logs', async () => {
      for (const id of ['orphan1', 'kept', 'orphan_2']) {
        await workspace.prepare(id);
        await workspace.writePrivateFile(id, 'cookies.txt', 'secret');
      }
      await writeFile(workspace.logFileOf('orphan1'), 'log');
      await workspace.sweep({ inUse: ['kept', 'not-present'], resumable: [] });
      assert.deepEqual(await readdir(path.join(dataDir, 'work')), ['kept']);
      assert.equal(await readFile(path.join(dataDir, 'work', 'kept', 'cookies.txt'), 'utf8'), 'secret');
      assert.equal(await readFile(workspace.logFileOf('orphan1'), 'utf8'), 'log');
    });

    it('keeps the temp files of resumable downloads but removes their secrets', async () => {
      for (const id of ['paused', 'running', 'done']) {
        const paths = await workspace.prepare(id);
        await workspace.writePrivateFile(id, 'cookies.txt', 'secret');
        await writeFile(path.join(paths.tempDir, 'a.part'), 'partial');
      }
      await workspace.sweep({ inUse: ['running'], resumable: ['paused', 'running'] });
      const work = path.join(dataDir, 'work');
      assert.deepEqual((await readdir(work)).sort(), ['paused', 'running']);
      assert.deepEqual(await readdir(path.join(work, 'paused')), ['tmp']);
      assert.equal(await readFile(path.join(work, 'paused', 'tmp', 'a.part'), 'utf8'), 'partial');
      assert.deepEqual((await readdir(path.join(work, 'running'))).sort(), ['cookies.txt', 'tmp'], 'in use wins');
    });

    it('ignores entries that are not job dirs: odd names, plain files and symlinks (never follows them)', async () => {
      await workspace.prepare('orphan');
      const work = path.join(dataDir, 'work');
      const outside = path.join(dataDir, 'outside');
      await mkdir(path.join(work, 'not.an.id'));
      await mkdir(outside);
      await writeFile(path.join(outside, 'precious.txt'), 'keep me');
      await writeFile(path.join(work, 'stray-file'), 'x');
      await symlink(outside, path.join(work, 'linked'), 'junction');
      await workspace.sweep({ inUse: [], resumable: ['linked'] });
      assert.deepEqual((await readdir(work)).sort(), ['linked', 'not.an.id', 'stray-file']);
      assert.equal(await readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
    });

    it('removes the temp files of interrupted log compactions, and nothing else in jobs/', async () => {
      await workspace.initialize();
      const jobs = path.join(dataDir, 'jobs');
      const names = ['job1.log', '.job1.log.0123456789ab.tmp', '.job2.log.deadbeef0000.tmp', '.other.tmp', 'notes.txt'];
      for (const name of names) await writeFile(path.join(jobs, name), 'x');
      await mkdir(path.join(jobs, '.job3.log.0123456789ab.tmp'));
      await workspace.sweep({ inUse: [], resumable: [] });
      assert.deepEqual((await readdir(jobs)).sort(), [
        '.job3.log.0123456789ab.tmp',
        '.other.tmp',
        'job1.log',
        'notes.txt'
      ]);
    });

    it('never throws: a missing work root is fine, other failures are logged', async () => {
      await workspace.sweep({ inUse: ['x'], resumable: [] });
      const logger = new RecordingLogger();
      const broken = await mkdtemp(path.join(os.tmpdir(), 'yami-ws-broken-'));
      try {
        await writeFile(path.join(broken, 'work'), 'not a directory');
        await new NodeJobWorkspace({ dataDir: broken, logger }).sweep({ inUse: [], resumable: [] });
        assert.equal(logger.entries.filter((entry) => entry.level === 'warn').length, 1);
      } finally {
        await rm(broken, { recursive: true, force: true });
      }
    });
  });
});
