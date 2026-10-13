import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { NodeProcessInspector } from './node-process-inspector.ts';
import { OsProcessIdentityReader } from './process-identity-reader.ts';
import type { PidProbe, ProcessSignal, ProcessSignals } from './process-signals.ts';
import type { ProcessIdentityReader, ProcessLookup, ProcessSnapshot } from './process-snapshot.ts';

class FakeSignals implements ProcessSignals {
  readonly alive = new Set<number>();
  readonly denied = new Set<number>();
  probe(pid: number): PidProbe {
    if (this.alive.has(pid)) return 'running';
    return this.denied.has(pid) ? 'denied' : 'missing';
  }
  send(_pid: number, _signal: ProcessSignal): boolean {
    return true;
  }
}

/** Every OS query (single or batched) is recorded as one batch. */
class FakeReader implements ProcessIdentityReader {
  readonly table = new Map<number, ProcessLookup>();
  batches: number[][] = [];
  async read(pid: number): Promise<ProcessLookup> {
    return (await this.readMany([pid])).get(pid) ?? null;
  }
  async readMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessLookup>> {
    this.batches.push([...pids]);
    return new Map(pids.map((pid) => [pid, this.table.get(pid) ?? null] as const));
  }
}

function snapshot(
  pid: number,
  startToken: string,
  source: ProcessSnapshot['startTokenSource'] = 'proc'
): ProcessSnapshot {
  return { pid, imageName: 'yt-dlp', startToken, startTokenSource: source, executablePath: null };
}

function identity(
  pid: number,
  startToken: string | null,
  source: ProcessIdentity['startTokenSource'] = 'proc'
): ProcessIdentity {
  return { pid, imageName: 'yt-dlp', startToken, startTokenSource: source, executable: '/bin/yt-dlp', capturedAt: 0 };
}

interface Setup {
  inspector: NodeProcessInspector;
  reader: FakeReader;
  signals: FakeSignals;
  clock: { t: number };
}

function setup(cacheTtlMs?: number): Setup {
  const reader = new FakeReader();
  const signals = new FakeSignals();
  const clock = { t: 1_000 };
  const inspector = new NodeProcessInspector({
    platform: 'linux',
    reader,
    signals,
    clock: { now: () => clock.t },
    batchWindowMs: 0,
    ...(cacheTtlMs === undefined ? {} : { cacheTtlMs })
  });
  return { inspector, reader, signals, clock };
}

describe('NodeProcessInspector — strict checks', () => {
  it('is false when kill(pid, 0) says the PID does not exist (no OS query)', async () => {
    const { inspector, reader } = setup();
    assert.equal(await inspector.isAlive(identity(10, '1'), { strict: true }), false);
    assert.equal(reader.batches.length, 0);
  });

  it('detects PID reuse through a different start token of the same source', async () => {
    const { inspector, reader, signals } = setup();
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, '999'));
    assert.equal(await inspector.isAlive(identity(10, '111'), { strict: true }), false);
    assert.equal(await inspector.isAlive(identity(10, '999'), { strict: true }), true);
  });

  it('treats a start-token source mismatch as a match (does not orphan the job)', async () => {
    const { inspector, reader, signals } = setup();
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, '2026-09-30T13:12:33.123Z', 'powershell'));
    const legacy = identity(10, '20260930101233.123456-180', 'wmic');
    assert.equal(await inspector.isAlive(legacy, { strict: true }), true);
  });

  it('always re-reads the OS, even with a fresh cache entry', async () => {
    const { inspector, reader, signals } = setup();
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, '5'));
    await inspector.aliveMany([identity(10, '5')]);
    await inspector.isAlive(identity(10, '5'), { strict: true });
    await inspector.check(identity(10, '5'));
    assert.equal(reader.batches.length, 3);
  });

  it('check() distinguishes alive, gone (dead or zombie) and mismatch (PID reuse)', async () => {
    const { inspector, reader, signals } = setup();
    assert.equal(await inspector.check(identity(10, '5')), 'gone');
    signals.alive.add(10);
    assert.equal(await inspector.check(identity(10, '5')), 'gone', 'kill(0) ok but the OS reports no live process');
    reader.table.set(10, snapshot(10, '5'));
    assert.equal(await inspector.check(identity(10, '5')), 'alive');
    assert.equal(await inspector.check(identity(10, '6')), 'mismatch');
  });

  it('check() reads EPERM as "not ours" without querying the OS', async () => {
    const { inspector, reader, signals } = setup();
    signals.denied.add(10);
    reader.table.set(10, snapshot(10, '5'));
    assert.equal(await inspector.check(identity(10, '5')), 'gone');
    assert.equal(reader.batches.length, 0);
  });

  it('coalesces concurrent strict checks (parallel terminations) into one OS query', async () => {
    const { inspector, reader, signals } = setup();
    for (const pid of [10, 11, 12]) {
      signals.alive.add(pid);
      reader.table.set(pid, snapshot(pid, 'x'));
    }
    const verdicts = await Promise.all([10, 11, 12].map((pid) => inspector.check(identity(pid, 'x'))));
    assert.deepEqual(verdicts, ['alive', 'alive', 'alive']);
    assert.deepEqual(reader.batches, [[10, 11, 12]]);
  });
});

describe('NodeProcessInspector — cheap checks (aliveMany / non-strict)', () => {
  it('uses kill(0) + the cached identity; the OS is re-read only when the entry expired', async () => {
    const { inspector, reader, signals, clock } = setup(10_000);
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, '5'));
    const id = identity(10, '5');
    assert.equal((await inspector.aliveMany([id])).get(10), true);
    clock.t += 9_999;
    assert.equal((await inspector.aliveMany([id])).get(10), true);
    assert.equal(await inspector.isAlive(id, { strict: false }), true);
    assert.equal(reader.batches.length, 1, 'served from the cache');
    clock.t += 1;
    assert.equal((await inspector.aliveMany([id])).get(10), true);
    assert.equal(reader.batches.length, 2, 'expired → refreshed');
  });

  it('caches for at least 10 s by default', async () => {
    const { inspector, reader, signals, clock } = setup();
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, '5'));
    await inspector.aliveMany([identity(10, '5')]);
    clock.t += 9_000;
    await inspector.aliveMany([identity(10, '5')]);
    assert.equal(reader.batches.length, 1);
  });

  it('reports a vanished PID (ESRCH) as dead immediately, without an OS query', async () => {
    const { inspector, reader, signals } = setup();
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, '5'));
    await inspector.aliveMany([identity(10, '5')]);
    signals.alive.delete(10);
    assert.equal((await inspector.aliveMany([identity(10, '5')])).get(10), false);
    assert.equal(reader.batches.length, 1);
    signals.alive.add(10);
    await inspector.aliveMany([identity(10, '5')]);
    assert.equal(reader.batches.length, 2, 'the cache entry was dropped with the PID');
  });

  it('treats EPERM as "exists" and lets the identity comparison decide', async () => {
    const { inspector, reader, signals } = setup();
    signals.denied.add(10).add(11);
    reader.table.set(10, snapshot(10, 'ours'));
    reader.table.set(11, snapshot(11, 'someone-else'));
    const result = await inspector.aliveMany([identity(10, 'ours'), identity(11, 'ours')]);
    assert.equal(result.get(10), true);
    assert.equal(result.get(11), false);
  });

  it('compares the cached identity: PID reuse already seen by the OS is reported as dead', async () => {
    const { inspector, reader, signals } = setup();
    signals.alive.add(10);
    reader.table.set(10, snapshot(10, 'other'));
    await inspector.check(identity(10, 'other'));
    assert.equal((await inspector.aliveMany([identity(10, 'mine')])).get(10), false);
    assert.equal(reader.batches.length, 1, 'strict reads feed the cache');
  });

  it('refreshes only the expired entries, in one batch, and never caches "gone"', async () => {
    const { inspector, reader, signals, clock } = setup(10_000);
    signals.alive.add(10).add(11).add(12);
    reader.table.set(10, snapshot(10, 'a'));
    reader.table.set(11, snapshot(11, 'b'));
    await inspector.aliveMany([identity(10, 'a')]);
    clock.t += 5_000;
    const ids = [identity(10, 'a'), identity(11, 'b'), identity(12, 'c'), identity(13, 'd')];
    const result = await inspector.aliveMany(ids);
    assert.deepEqual(reader.batches, [[10], [11, 12]], '10 is cached, 13 fails kill(0)');
    assert.deepEqual(
      [...result.entries()].sort((x, y) => x[0] - y[0]),
      [
        [10, true],
        [11, true],
        [12, false],
        [13, false]
      ]
    );
    await inspector.aliveMany(ids);
    assert.deepEqual(reader.batches.at(-1), [12], 'a null lookup is re-read on the next pass');
  });
});

describe('NodeProcessInspector (real OS)', { skip: process.platform !== 'linux' }, () => {
  it('recognizes the current process and rejects a forged start token', async () => {
    const reader = new OsProcessIdentityReader({ platform: 'linux', runner: new FakeCommandRunner() });
    const inspector = new NodeProcessInspector({ platform: 'linux', reader });
    const self = await reader.read(process.pid);
    assert.ok(self);
    const real: ProcessIdentity = {
      pid: process.pid,
      imageName: self.imageName,
      startToken: self.startToken,
      startTokenSource: self.startTokenSource,
      executable: process.execPath,
      capturedAt: Date.now()
    };
    assert.equal(await inspector.isAlive(real, { strict: true }), true);
    assert.equal(await inspector.isAlive({ ...real, startToken: '1' }, { strict: true }), false);
    assert.equal((await inspector.aliveMany([real])).get(process.pid), true);
  });
});
