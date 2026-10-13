import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { delay } from '../../../shared/kernel/async.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import { commandOk, FakeCommandRunner } from './fake-command-runner.ts';
import { NodeProcessInspector, type ProcessCheck, type ProcessIdentityChecker } from './node-process-inspector.ts';
import { NodeProcessLauncher } from './node-process-launcher.ts';
import { NodeProcessTerminator } from './node-process-terminator.ts';
import { OsProcessIdentityReader } from './process-identity-reader.ts';
import { NodeProcessSignals, type PidProbe, type ProcessSignal, type ProcessSignals } from './process-signals.ts';
import type { ProcessIdentityReader, ProcessLookup, ProcessSnapshot } from './process-snapshot.ts';

const isLinux = process.platform === 'linux';

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

async function waitForLog(file: string, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (pattern.test(text)) return text;
    await delay(25);
  }
  throw new Error(`log never matched ${pattern}`);
}

describe('NodeProcessTerminator (real processes)', { skip: !isLinux }, () => {
  let dir = '';
  const runner = new FakeCommandRunner();
  const reader = new OsProcessIdentityReader({ platform: 'linux', runner });
  const inspector = new NodeProcessInspector({ platform: 'linux', reader });
  const launcher = new NodeProcessLauncher({ platform: 'linux', reader });
  const signals = new NodeProcessSignals();

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-kill-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  async function launch(script: string, name: string): Promise<{ identity: ProcessIdentity; log: string }> {
    const log = path.join(dir, `${name}.log`);
    const result = await launcher.launch({
      executable: process.execPath,
      args: ['-e', script],
      env: childEnv(),
      cwd: dir,
      logFile: log
    });
    assert.ok(result.ok);
    return { identity: result.value.identity, log };
  }

  it('kills the whole process group (engine + its children)', async () => {
    const { identity, log } = await launch(
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
        "console.log('child=' + c.pid); setInterval(() => {}, 1000);",
      'tree'
    );
    const text = await waitForLog(log, /child=\d+/);
    const grandchild = Number(/child=(\d+)/.exec(text)?.[1]);
    const terminator = new NodeProcessTerminator({ platform: 'linux', inspector, runner });
    assert.equal(await terminator.terminate(identity), true);
    assert.equal(signals.probe(identity.pid), 'missing');
    const start = Date.now();
    while (signals.probe(grandchild) === 'running' && Date.now() - start < 3_000) await delay(25);
    assert.notEqual(signals.probe(grandchild), 'running', 'grandchild in the same group is killed too');
  });

  it('refuses to kill when the strict identity check fails (PID reuse) and leaves the process running', async () => {
    const { identity, log } = await launch("console.log('ready'); setInterval(() => {}, 1000);", 'refuse');
    await waitForLog(log, /ready/);
    const terminator = new NodeProcessTerminator({ platform: 'linux', inspector, runner });
    const forged: ProcessIdentity = { ...identity, startToken: '1', startTokenSource: 'proc' };
    assert.equal(await terminator.terminate(forged), false);
    assert.equal(signals.probe(identity.pid), 'running');
    assert.equal(await terminator.terminate(identity), true);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { identity, log } = await launch(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
      'stubborn'
    );
    await waitForLog(log, /ready/);
    const terminator = new NodeProcessTerminator({
      platform: 'linux',
      inspector,
      runner,
      gracePeriodMs: 300,
      exitTimeoutMs: 5_000
    });
    assert.equal(await terminator.terminate(identity), true);
    assert.equal(signals.probe(identity.pid), 'missing');
  });

  it('returns true for a process that is already gone', async () => {
    const { identity, log } = await launch("console.log('bye')", 'gone');
    await waitForLog(log, /bye/);
    const start = Date.now();
    while (signals.probe(identity.pid) === 'running' && Date.now() - start < 3_000) await delay(25);
    const terminator = new NodeProcessTerminator({ platform: 'linux', inspector, runner });
    assert.equal(await terminator.terminate(identity), true);
  });
});

class FakeSignals implements ProcessSignals {
  readonly alive = new Set<number>();
  readonly denied = new Set<number>();
  readonly sent: [number, ProcessSignal][] = [];
  probe(pid: number): PidProbe {
    if (this.alive.has(pid)) return 'running';
    return this.denied.has(pid) ? 'denied' : 'missing';
  }
  send(pid: number, signal: ProcessSignal): boolean {
    this.sent.push([pid, signal]);
    return true;
  }
}

/** Fixed verdict; counts strict identity reads. */
class CountingChecker implements ProcessIdentityChecker {
  checks = 0;
  readonly #verdict: ProcessCheck;
  constructor(verdict: ProcessCheck) {
    this.#verdict = verdict;
  }
  async check(): Promise<ProcessCheck> {
    this.checks += 1;
    return this.#verdict;
  }
}

function fakeInspector(verdict: ProcessCheck): ProcessIdentityChecker {
  return new CountingChecker(verdict);
}

/** Windows identity source: every query is one (fake) PowerShell spawn. */
class FakePowershellReader implements ProcessIdentityReader {
  readonly queries: number[][] = [];
  readonly table = new Map<number, ProcessSnapshot>();
  async read(pid: number): Promise<ProcessLookup> {
    return (await this.readMany([pid])).get(pid) ?? null;
  }
  async readMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessLookup>> {
    this.queries.push([...pids]);
    return new Map(pids.map((pid) => [pid, this.table.get(pid) ?? null] as const));
  }
}

const identity: ProcessIdentity = {
  pid: 4242,
  imageName: 'yt-dlp.exe',
  startToken: '2026-09-30T13:12:33.123Z',
  startTokenSource: 'powershell',
  executable: 'C:\\bin\\yt-dlp.exe',
  capturedAt: 0
};

describe('NodeProcessTerminator (win32, fakes)', () => {
  it('runs taskkill /PID <pid> /T /F and waits for the exit', async () => {
    const signals = new FakeSignals();
    signals.alive.add(4242);
    const runner = new FakeCommandRunner().respond('taskkill.exe', () => {
      signals.alive.delete(4242);
      return commandOk('SUCCESS');
    });
    const terminator = new NodeProcessTerminator({
      platform: 'win32',
      inspector: fakeInspector('alive'),
      runner,
      signals,
      systemRoot: 'C:\\Windows',
      sleep: async () => undefined
    });
    assert.equal(await terminator.terminate(identity), true);
    const call = runner.callsTo('taskkill.exe')[0];
    assert.equal(call?.file, 'C:\\Windows\\System32\\taskkill.exe');
    assert.deepEqual(call?.args, ['/PID', '4242', '/T', '/F']);
    assert.equal(signals.sent.length, 0, 'no POSIX signals on Windows');
  });

  it('refuses (no taskkill) when the identity does not match', async () => {
    const signals = new FakeSignals();
    signals.alive.add(4242);
    const runner = new FakeCommandRunner();
    const terminator = new NodeProcessTerminator({
      platform: 'win32',
      inspector: fakeInspector('mismatch'),
      runner,
      signals,
      systemRoot: 'C:\\Windows'
    });
    assert.equal(await terminator.terminate(identity), false);
    assert.equal(runner.calls.length, 0);
  });

  it('reports false when the process survives the timeout', async () => {
    const signals = new FakeSignals();
    signals.alive.add(4242);
    const runner = new FakeCommandRunner().respond('taskkill.exe', commandOk('', 1));
    let now = 0;
    const terminator = new NodeProcessTerminator({
      platform: 'win32',
      inspector: fakeInspector('alive'),
      runner,
      signals,
      systemRoot: 'C:\\Windows',
      clock: { now: () => now },
      sleep: async (ms) => {
        now += ms;
      }
    });
    assert.equal(await terminator.terminate(identity), false);
  });
});

describe('NodeProcessTerminator (cost budget, fakes)', () => {
  it('returns true for an already-gone PID without any identity read or kill', async () => {
    for (const state of ['missing', 'denied'] as const) {
      const signals = new FakeSignals();
      if (state === 'denied') signals.denied.add(4242);
      const checker = new CountingChecker('alive');
      const runner = new FakeCommandRunner();
      const terminator = new NodeProcessTerminator({
        platform: 'win32',
        inspector: checker,
        runner,
        signals,
        systemRoot: 'C:\\Windows'
      });
      assert.equal(await terminator.terminate(identity), true, state);
      assert.equal(checker.checks, 0, state);
      assert.equal(runner.calls.length, 0, state);
    }
  });

  it('does exactly one strict identity read, even when the process survives the timeout', async () => {
    const signals = new FakeSignals();
    signals.alive.add(4242);
    const checker = new CountingChecker('alive');
    let now = 0;
    const terminator = new NodeProcessTerminator({
      platform: 'win32',
      inspector: checker,
      runner: new FakeCommandRunner().respond('taskkill.exe', commandOk('', 1)),
      signals,
      systemRoot: 'C:\\Windows',
      clock: { now: () => now },
      sleep: async (ms) => {
        now += ms;
      }
    });
    assert.equal(await terminator.terminate(identity), false);
    assert.equal(checker.checks, 1);
  });

  it('parallel terminations share ONE PowerShell identity query', async () => {
    const pids = [4242, 4243, 4244, 4245];
    const signals = new FakeSignals();
    const reader = new FakePowershellReader();
    for (const pid of pids) {
      signals.alive.add(pid);
      reader.table.set(pid, {
        pid,
        imageName: 'yt-dlp.exe',
        startToken: identity.startToken,
        startTokenSource: 'powershell',
        executablePath: null
      });
    }
    const inspector = new NodeProcessInspector({ platform: 'win32', reader, signals, batchWindowMs: 5 });
    const runner = new FakeCommandRunner().respond('taskkill.exe', (call) => {
      signals.alive.delete(Number(call.args[1]));
      return commandOk('SUCCESS');
    });
    const terminator = new NodeProcessTerminator({
      platform: 'win32',
      inspector,
      runner,
      signals,
      systemRoot: 'C:\\Windows',
      sleep: async () => undefined
    });
    const results = await Promise.all(pids.map((pid) => terminator.terminate({ ...identity, pid })));
    assert.deepEqual(results, [true, true, true, true]);
    assert.deepEqual(reader.queries, [pids]);
    assert.equal(runner.callsTo('taskkill.exe').length, pids.length);
  });
});

describe('NodeProcessTerminator (posix, fakes)', () => {
  it('re-verifies identity before SIGKILL and skips it when the PID was reused', async () => {
    const signals = new FakeSignals();
    signals.alive.add(4242);
    let strictChecks = 0;
    const inspector: ProcessIdentityChecker = {
      // First check (before SIGTERM) matches; the re-check before SIGKILL sees another process.
      check: async () => (++strictChecks === 1 ? 'alive' : 'mismatch')
    };
    let now = 0;
    const terminator = new NodeProcessTerminator({
      platform: 'linux',
      inspector,
      runner: new FakeCommandRunner(),
      signals,
      clock: { now: () => now },
      sleep: async (ms) => {
        now += ms;
      },
      gracePeriodMs: 300
    });
    assert.equal(await terminator.terminate(identity), true);
    assert.deepEqual(signals.sent, [[-4242, 'SIGTERM']]);
  });
});
