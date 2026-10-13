import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { NodeProcessLauncher } from './node-process-launcher.ts';
import { OsProcessIdentityReader } from './process-identity-reader.ts';
import type { ProcessIdentityReader, ProcessLookup } from './process-snapshot.ts';

const isPosix = process.platform !== 'win32';

/** The launcher unref()s children (the host's IPC port keeps its loop alive); tests must do it themselves. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const timer = setInterval(() => undefined, 50);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

describe('NodeProcessLauncher', { skip: !isPosix }, () => {
  let dir = '';
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const reader = new OsProcessIdentityReader({ platform, runner: new FakeCommandRunner() });
  const launcher = new NodeProcessLauncher({ platform, reader, clock: { now: () => 123 } });

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-launch-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('spawns detached, redirects stdout+stderr to a 0600 log and reports the exit', async () => {
    const logFile = path.join(dir, 'jobs', 'a.log');
    const result = await launcher.launch({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('olá mundo\\n'); process.stderr.write('ERROR: falhou\\n'); process.exit(3)"],
      env: childEnv(),
      cwd: dir,
      logFile
    });
    assert.ok(result.ok, JSON.stringify(!result.ok && result.error));
    const { identity, exited } = result.value;
    assert.ok(identity.pid > 0);
    assert.equal(identity.executable, process.execPath);
    assert.equal(identity.capturedAt, 123);
    assert.ok(identity.imageName);
    assert.deepEqual(await settle(exited), { code: 3, signal: null });
    const log = await readFile(logFile, 'utf8');
    assert.match(log, /olá mundo/);
    assert.match(log, /ERROR: falhou/);
    assert.equal((await stat(logFile)).mode & 0o777, 0o600);
  });

  it('truncates the previous log on every launch', async () => {
    const logFile = path.join(dir, 'b.log');
    for (const text of ['first run with a long line', 'second']) {
      const result = await launcher.launch({
        executable: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(text)})`],
        env: childEnv(),
        cwd: dir,
        logFile
      });
      assert.ok(result.ok);
      await settle(result.value.exited);
    }
    assert.equal(await readFile(logFile, 'utf8'), 'second\n');
  });

  it('captures the OS identity (start token) right after spawn', async () => {
    if (process.platform !== 'linux') return;
    const result = await launcher.launch({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      env: childEnv(),
      cwd: dir,
      logFile: path.join(dir, 'c.log')
    });
    assert.ok(result.ok);
    const { identity, exited } = result.value;
    assert.equal(identity.startTokenSource, 'proc');
    assert.match(identity.startToken ?? '', /^\d+$/);
    process.kill(identity.pid, 'SIGKILL');
    assert.equal((await settle(exited)).signal, 'SIGKILL');
  });

  it('falls back to the executable name when the OS query yields nothing', async () => {
    const empty: ProcessIdentityReader = {
      read: async (): Promise<ProcessLookup> => null,
      readMany: async () => new Map()
    };
    const blind = new NodeProcessLauncher({ platform: 'linux', reader: empty });
    const result = await blind.launch({
      executable: process.execPath,
      args: ['-e', ''],
      env: childEnv(),
      cwd: dir,
      logFile: path.join(dir, 'd.log')
    });
    assert.ok(result.ok);
    assert.equal(result.value.identity.imageName, path.basename(process.execPath).toLowerCase());
    assert.equal(result.value.identity.startToken, null);
    assert.equal(result.value.identity.startTokenSource, null);
    await settle(result.value.exited);
  });

  it('rejects relative executables', async () => {
    const result = await launcher.launch({
      executable: 'node',
      args: [],
      env: {},
      cwd: dir,
      logFile: path.join(dir, 'e.log')
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, ErrorCode.INTERNAL);
  });

  it('maps spawn errors (missing executable) to INTERNAL with a detail', async () => {
    const result = await launcher.launch({
      executable: path.join(dir, 'does-not-exist'),
      args: [],
      env: {},
      cwd: dir,
      logFile: path.join(dir, 'f.log')
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, ErrorCode.INTERNAL);
      assert.match(String(result.error.params?.['detail']), /ENOENT/);
    }
  });
});

describe('NodeProcessLauncher (win32 paths)', () => {
  it('validates absoluteness with win32 rules', async () => {
    const launcher = new NodeProcessLauncher({
      platform: 'win32',
      reader: { read: async () => null, readMany: async () => new Map() }
    });
    const result = await launcher.launch({
      executable: 'yt-dlp.exe',
      args: [],
      env: {},
      cwd: 'C:\\',
      logFile: 'C:\\x.log'
    });
    assert.equal(result.ok, false);
  });
});
