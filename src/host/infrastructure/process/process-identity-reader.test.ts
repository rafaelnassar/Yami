import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { commandFailed, commandOk, FakeCommandRunner } from './fake-command-runner.ts';
import { OsProcessIdentityReader } from './process-identity-reader.ts';
import { unknownSnapshot } from './process-snapshot.ts';

const NON_EXISTENT_PID = 0x7ffffff0;
const isLinux = process.platform === 'linux';

describe('OsProcessIdentityReader (linux /proc)', { skip: !isLinux }, () => {
  const reader = new OsProcessIdentityReader({ platform: 'linux', runner: new FakeCommandRunner() });

  it('reads comm, starttime and exe of a live process', async () => {
    const first = await reader.read(process.pid);
    const second = await reader.read(process.pid);
    assert.ok(first);
    assert.equal(first.pid, process.pid);
    assert.ok(first.imageName);
    assert.equal(first.startTokenSource, 'proc');
    assert.match(first.startToken ?? '', /^\d+$/);
    assert.equal(second?.startToken, first.startToken, 'start token is stable');
    assert.equal(first.executablePath, await realpath(process.execPath));
  });

  it('returns null for a PID that does not exist and for invalid PIDs', async () => {
    assert.equal(await reader.read(NON_EXISTENT_PID), null);
    assert.equal(await reader.read(-1), null);
    const many = await reader.readMany([process.pid, NON_EXISTENT_PID, 0]);
    assert.ok(many.get(process.pid));
    assert.equal(many.get(NON_EXISTENT_PID), null);
    assert.equal(many.get(0), null);
  });

  describe('with a fake procfs', () => {
    let root = '';
    before(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'yami-proc-'));
      const filler = Array.from({ length: 18 }, (_, i) => String(i)).join(' ');
      await mkdir(path.join(root, '10'));
      await writeFile(path.join(root, '10', 'stat'), `10 (yt-dlp) Z ${filler} 555 0\n`);
      await mkdir(path.join(root, '11'));
      await writeFile(path.join(root, '11', 'stat'), `11 (gallery-dl) S ${filler} 777 0\n`);
      await writeFile(path.join(root, '11', 'comm'), 'Gallery-DL\n');
    });
    after(() => rm(root, { recursive: true, force: true }));

    it('treats zombies as gone and tolerates a missing exe link', async () => {
      const fake = new OsProcessIdentityReader({ platform: 'linux', runner: new FakeCommandRunner(), procRoot: root });
      assert.equal(await fake.read(10), null);
      assert.deepEqual(await fake.read(11), {
        pid: 11,
        imageName: 'gallery-dl',
        startToken: '777',
        startTokenSource: 'proc',
        executablePath: null
      });
    });
  });
});

describe('OsProcessIdentityReader (win32, fake runner)', () => {
  const psRow = (pid: number, name: string): string =>
    `{"ProcessId":${pid},"Name":"${name}","CreationDate":"2026-09-30T13:12:33.1234567Z","ExecutablePath":"C:\\\\bin\\\\${name}"}`;

  it('queries many PIDs with ONE PowerShell call and marks absent ones as gone', async () => {
    const runner = new FakeCommandRunner().respond('powershell.exe', commandOk(`[${psRow(10, 'yt-dlp.exe')}]`));
    const reader = new OsProcessIdentityReader({ platform: 'win32', runner, systemRoot: 'D:\\Win' });
    const result = await reader.readMany([10, 20]);
    assert.equal(runner.calls.length, 1);
    const call = runner.calls[0];
    assert.equal(call?.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(call?.options.timeoutMs, 8_000);
    assert.match(call?.args.at(-1) ?? '', /ProcessId=10 OR ProcessId=20/);
    assert.deepEqual(result.get(10), {
      pid: 10,
      imageName: 'yt-dlp.exe',
      startToken: '2026-09-30T13:12:33.123Z',
      startTokenSource: 'powershell',
      executablePath: 'C:\\bin\\yt-dlp.exe'
    });
    assert.equal(result.get(20), null);
  });

  it('splits very large batches', async () => {
    const runner = new FakeCommandRunner().respond('powershell.exe', commandOk('[]'));
    const reader = new OsProcessIdentityReader({ platform: 'win32', runner, systemRoot: 'C:\\Windows' });
    const pids = Array.from({ length: 70 }, (_, i) => i + 1);
    const result = await reader.readMany(pids);
    assert.equal(runner.callsTo('powershell.exe').length, 2);
    assert.equal(result.size, 70);
  });

  it('falls back to tasklist (image name only) when PowerShell fails', async () => {
    const runner = new FakeCommandRunner()
      .respond('powershell.exe', commandOk('', 1))
      .respond(
        'tasklist.exe',
        commandOk('"yt-dlp.exe","10","Console","1","5 K"\r\n"svchost.exe","4","Services","0","1 K"\r\n')
      );
    const reader = new OsProcessIdentityReader({ platform: 'win32', runner, systemRoot: 'C:\\Windows' });
    const result = await reader.readMany([10, 20]);
    const tasklist = runner.callsTo('tasklist.exe');
    assert.equal(tasklist.length, 1);
    assert.deepEqual(tasklist[0]?.args, ['/FO', 'CSV', '/NH']);
    assert.deepEqual(result.get(10), { ...unknownSnapshot(10), imageName: 'yt-dlp.exe' });
    assert.equal(result.get(20), null);
  });

  it('filters tasklist by PID for a single lookup', async () => {
    const runner = new FakeCommandRunner()
      .respond('powershell.exe', commandFailed('ETIMEDOUT'))
      .respond('tasklist.exe', commandOk('INFO: No tasks are running which match the specified criteria.\r\n'));
    const reader = new OsProcessIdentityReader({ platform: 'win32', runner, systemRoot: 'C:\\Windows' });
    assert.equal(await reader.read(10), null);
    assert.deepEqual(runner.callsTo('tasklist.exe')[0]?.args, ['/FI', 'PID eq 10', '/FO', 'CSV', '/NH']);
  });

  it('reports unknown (not gone) when every backend fails', async () => {
    const runner = new FakeCommandRunner()
      .respond('powershell.exe', commandFailed())
      .respond('tasklist.exe', commandFailed());
    const reader = new OsProcessIdentityReader({ platform: 'win32', runner, systemRoot: 'C:\\Windows' });
    assert.deepEqual(await reader.read(10), unknownSnapshot(10));
  });

  it('never invokes wmic', async () => {
    const runner = new FakeCommandRunner().respond('powershell.exe', commandOk('[]'));
    const reader = new OsProcessIdentityReader({ platform: 'win32', runner, systemRoot: 'C:\\Windows' });
    await reader.readMany([1, 2, 3]);
    assert.equal(
      runner.calls.some((call) => /wmic/i.test(call.file)),
      false
    );
  });
});

describe('OsProcessIdentityReader (darwin, fake runner)', () => {
  it('uses one ps call with LC_ALL=C and maps rows back to PIDs', async () => {
    const runner = new FakeCommandRunner().respond(
      'ps',
      commandOk('  501 Tue Sep 30 10:12:33 2026     /opt/yami/bin/yt-dlp\n', 1)
    );
    const reader = new OsProcessIdentityReader({ platform: 'darwin', runner });
    const result = await reader.readMany([501, 502]);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.file, '/bin/ps');
    assert.equal(runner.calls[0]?.options.env?.['LC_ALL'], 'C');
    assert.deepEqual(result.get(501), {
      pid: 501,
      imageName: 'yt-dlp',
      startToken: 'Tue Sep 30 10:12:33 2026',
      startTokenSource: 'ps',
      executablePath: '/opt/yami/bin/yt-dlp'
    });
    assert.equal(result.get(502), null);
  });

  it('reports unknown when ps cannot run', async () => {
    const runner = new FakeCommandRunner().respond('ps', commandFailed());
    const reader = new OsProcessIdentityReader({ platform: 'darwin', runner });
    assert.deepEqual(await reader.read(501), unknownSnapshot(501));
  });
});
