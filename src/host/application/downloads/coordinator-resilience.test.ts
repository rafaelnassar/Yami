import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crashedHost, secondHost } from './testing/crash.ts';
import { out } from './testing/fake-engines.ts';
import { FakeLogStore } from './testing/fake-logs.ts';
import { InMemoryPersistence } from './testing/fake-persistence.ts';
import { FakeProcessHost } from './testing/fake-processes.ts';
import { DownloadsHarness, settleMicrotasks } from './testing/harness.ts';

describe('DownloadCoordinator — quit is bounded', () => {
  it('shutdown stops engines in parallel; engines not stopped by the deadline stay running for re-attach', async () => {
    const h = new DownloadsHarness({ options: { shutdownDeadlineMs: 12_000, maxSlotWeight: 2 } });
    const { conversationIds } = await h.startOk(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    const [a = '', b = '', queued = ''] = conversationIds;
    h.processes.terminateBehavior = 'hang';
    const done = h.coordinator.shutdown('pause');
    await settleMicrotasks();
    assert.equal(h.processes.terminating.length, 2, 'both terminations started at once');
    assert.equal(h.timers.pending, 1, 'only the shutdown deadline is armed');
    await h.timers.runNext();
    await done;
    for (const id of [a, b]) {
      assert.equal(h.record(id).status, 'running', id);
      assert.ok(h.record(id).process, id);
    }
    assert.equal(h.record(queued).status, 'pending');

    // Terminations completing after the deadline change nothing.
    h.processes.releaseTerminations();
    await settleMicrotasks();
    assert.equal(h.record(a).status, 'running');
    assert.ok(h.record(a).process);
  });

  it('pauseAll and stopAll stop engines in parallel', async () => {
    for (const command of ['pauseAll', 'stopAll'] as const) {
      const h = new DownloadsHarness();
      await h.startOk(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
      h.processes.terminateBehavior = 'hang';
      const pending = h.coordinator[command]();
      await settleMicrotasks();
      assert.equal(h.processes.terminating.length, 3, command);
      h.processes.releaseTerminations();
      assert.deepEqual(await pending, { affected: 3 }, command);
      assert.equal(h.processes.running().length, 0, command);
    }
  });
});

describe('DownloadCoordinator — re-attach hardening', () => {
  it('a download that cannot be re-attached is stopped and paused, never left running unsupervised', async () => {
    const crashed = await crashedHost();
    const h = secondHost(crashed, { alive: true });
    h.logs.failOpen = true;
    await h.coordinator.initialize();
    await h.whenIdle();
    const record = h.record(crashed.id);
    assert.equal(record.status, 'paused');
    assert.equal(record.process, null);
    assert.deepEqual(h.processes.terminated, [crashed.pid]);
    assert.equal(h.persistence.events.codesOf(crashed.id).at(-1), 'pausedUnsupervised');

    h.logs.failOpen = false;
    assert.equal((await h.coordinator.resume(crashed.id)).ok, true);
    await h.whenIdle();
    assert.equal(h.record(crashed.id).status, 'running');
  });

  it('when that engine cannot be stopped either, it is supervised by liveness until it exits', async () => {
    const crashed = await crashedHost();
    const h = secondHost(crashed, { alive: true });
    h.logs.failOpen = true;
    h.processes.terminateBehavior = 'refuse';
    await h.coordinator.initialize();
    await h.whenIdle();
    assert.equal(h.record(crashed.id).status, 'running');
    assert.ok(h.timers.pending > 0, 'supervised');
    h.processes.external.set(crashed.pid, false);
    await h.settle();
    assert.equal(h.record(crashed.id).status, 'completed');
  });

  it('re-attached engines are checked for liveness at most every livenessEveryMs', async () => {
    const crashed = await crashedHost();
    const h = secondHost(crashed, { alive: true }, { pollMinMs: 300, pollMaxMs: 300, livenessEveryMs: 2000 });
    await h.coordinator.initialize();
    for (let i = 0; i < 6; i += 1) await h.tick();
    assert.equal(h.processes.aliveManyCalls, 1);
    assert.equal(h.processes.strictChecks, 1, 'only the re-attach check is strict');
    await h.tick();
    await h.tick();
    assert.equal(h.processes.aliveManyCalls, 2);
  });

  it('re-attach counts every stored file even when the counters were persisted earlier (persistEveryMs > 0)', async () => {
    const persistence = new InMemoryPersistence();
    const logs = new FakeLogStore();
    const first = new DownloadsHarness({
      persistence,
      logs,
      options: { persistEveryMs: 5000, pollMinMs: 1000, pollMaxMs: 1000 }
    });
    const { conversationIds } = await first.startOk(['https://site.com/a']);
    const id = conversationIds[0] ?? '';
    const engine = first.processes.last();
    engine.write(out.file('/dl/a.jpg'));
    await first.tick();
    for (let i = 0; i < 5; i += 1) {
      engine.write(out.progress(i * 10));
      await first.tick();
    }
    engine.write(out.file('/dl/b.jpg'), out.progress(90));
    await first.tick();
    engine.write(out.progress(95));
    await first.tick(); // host crashes after this pass

    const processes = new FakeProcessHost(logs);
    processes.external.set(engine.identity.pid, true);
    const h = new DownloadsHarness({ persistence, logs, processes, options: { persistEveryMs: 5000 } });
    await h.coordinator.initialize();
    logs.append(engine.spec.logFile, [out.file('/dl/c.jpg')]);
    await h.tick();
    assert.deepEqual(h.record(id).counters, { done: 3, skipped: 0, errors: 0 });
    assert.equal(persistence.files.rows.length, 3);
  });

  it('sweeps leftover private job dirs at start-up, keeping the re-attached ones', async () => {
    const alive = await crashedHost();
    const h = secondHost(alive, { alive: true });
    await h.coordinator.initialize();
    assert.deepEqual(h.workspace.sweeps, [{ inUse: [alive.id], resumable: [] }]);

    const dead = await crashedHost();
    const next = secondHost(dead, { alive: false });
    await next.coordinator.initialize();
    assert.deepEqual(next.workspace.sweeps, [{ inUse: [], resumable: [] }], 'finalized: nothing to keep');
    assert.deepEqual(next.workspace.cleanups, [{ id: dead.id, removeLog: false }], 'retired when finalized');
  });

  it('the start-up sweep keeps the temp files of paused and queued downloads (partial files continue)', async () => {
    const persistence = new InMemoryPersistence();
    const logs = new FakeLogStore();
    const first = new DownloadsHarness({ persistence, logs, options: { maxSlotWeight: 1 } });
    const urls = ['https://a.com/running', 'https://a.com/paused', 'https://a.com/queued', 'https://a.com/stopped'];
    const [running = '', paused = '', queued = '', stopped = ''] = (await first.startOk(urls)).conversationIds;
    await first.coordinator.pause(paused);
    await first.coordinator.stop(stopped);
    await first.whenIdle();
    const engine = first.processes.byPid(first.record(running).process?.pid ?? -1);
    assert.ok(engine?.alive);
    // Host crash: the first host is abandoned with its engine still running.
    const processes = new FakeProcessHost(logs);
    processes.external.set(engine.identity.pid, true);
    const h = new DownloadsHarness({ persistence, logs, processes });
    await h.coordinator.initialize();
    assert.deepEqual(h.workspace.sweeps, [{ inUse: [running], resumable: [paused, queued] }]);
  });
});
