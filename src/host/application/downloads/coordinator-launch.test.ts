import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gate } from './testing/fake-files.ts';
import { FakeProcessHost, LAUNCH_FAILED } from './testing/fake-processes.ts';
import { DownloadsHarness, settleMicrotasks } from './testing/harness.ts';

/** Starts a download whose launch blocks in the (slow) workspace preparation. */
async function launching(h: DownloadsHarness, url = 'https://a.com/slow') {
  const slow = gate();
  h.workspace.gate = slow.promise;
  const started = await h.coordinator.start({
    urls: [url],
    engine: 'gallery-dl',
    scope: 'single',
    cookieNames: null,
    folderId: null
  });
  if (!started.ok) throw new Error(started.error.code);
  await settleMicrotasks();
  return {
    id: started.value.conversationIds[0] ?? '',
    release: async () => {
      h.workspace.gate = null;
      slow.open();
      await h.whenIdle();
    }
  };
}

describe('DownloadCoordinator — launches run outside the mutex', () => {
  it('a slow launch does not block commands on other downloads', async () => {
    const h = new DownloadsHarness();
    const { conversationIds } = await h.startOk(['https://a.com/running']);
    const first = conversationIds[0] ?? '';
    const slow = await launching(h);
    assert.equal(h.record(first).status, 'running');
    const paused = await h.coordinator.pause(first); // would dead-lock if the launch held the mutex
    assert.equal(paused.ok, true);
    assert.equal(h.record(slow.id).status, 'pending');
    await slow.release();
    assert.equal(h.record(slow.id).status, 'running');
  });

  it('paused, stopped or forgotten while launching: the new engine is terminated and the row stays consistent', async () => {
    for (const command of ['pause', 'stop', 'forget'] as const) {
      const h = new DownloadsHarness();
      const slow = await launching(h);
      assert.equal((await h.coordinator[command](slow.id)).ok, true, command);
      await slow.release();
      const process = h.processes.last();
      assert.equal(process.alive, false, `${command}: engine terminated`);
      assert.deepEqual(h.processes.terminated, [process.identity.pid]);
      const record = h.record(slow.id);
      assert.equal(record.status, { pause: 'paused', stop: 'cancelled', forget: 'pending' }[command], command);
      assert.equal(record.process, null, `${command}: no process left on the row`);
      assert.ok(!h.persistence.events.codesOf(slow.id).includes('started'), command);
      assert.equal(h.coordinator.hasActive(), false, command);
      assert.ok(h.workspace.secretRemovals.includes(slow.id), `${command}: secrets of the unwanted run removed`);
      // Paused: temp files kept for the next run. Stopped: retired once its engine is gone. Forgotten: log removed too.
      const { cleanups } = h.workspace;
      if (command === 'pause') assert.deepEqual(cleanups, [], command);
      if (command === 'stop') assert.deepEqual(cleanups, [{ id: slow.id, removeLog: false }], command);
      if (command === 'forget') assert.ok(cleanups.length > 0 && cleanups.every((entry) => entry.removeLog), command);
    }
  });

  it('a stopped launch is retired only after its engine is gone (never while it may write the log)', async () => {
    const h = new DownloadsHarness();
    const slow = await launching(h);
    assert.equal((await h.coordinator.stop(slow.id)).ok, true);
    assert.deepEqual(h.workspace.cleanups, [], 'not retired while the launch is in flight');
    await slow.release();
    assert.equal(h.processes.last().alive, false);
    assert.deepEqual(h.workspace.cleanups, [{ id: slow.id, removeLog: false }]);
  });

  it('a row deleted while its stopped launch was in flight is retired with its log', async () => {
    const h = new DownloadsHarness();
    const slow = await launching(h);
    assert.equal((await h.coordinator.stop(slow.id)).ok, true);
    h.persistence.downloads.delete(slow.id);
    await slow.release();
    assert.deepEqual(h.workspace.cleanups, [{ id: slow.id, removeLog: true }]);
  });

  it('a stopped launch whose engine cannot be killed is not retired (it may still write its log)', async () => {
    const h = new DownloadsHarness();
    const slow = await launching(h);
    assert.equal((await h.coordinator.stop(slow.id)).ok, true);
    h.processes.terminateBehavior = 'refuse';
    await slow.release();
    assert.equal(h.processes.last().alive, true);
    assert.deepEqual(h.workspace.cleanups, []);
    assert.ok(h.workspace.secretRemovals.includes(slow.id));
  });

  it('a launch that failed after a pause keeps the temp files; a stopped one is retired', async () => {
    for (const command of ['pause', 'stop'] as const) {
      const h = new DownloadsHarness();
      const slow = await launching(h);
      h.processes.launchError = LAUNCH_FAILED;
      assert.equal((await h.coordinator[command](slow.id)).ok, true, command);
      await slow.release();
      assert.equal(h.record(slow.id).status, command === 'pause' ? 'paused' : 'cancelled', command);
      assert.ok(h.workspace.secretRemovals.includes(slow.id), command);
      assert.deepEqual(h.workspace.cleanups, command === 'pause' ? [] : [{ id: slow.id, removeLog: false }], command);
    }
  });

  it('a host crash between spawn and commit re-attaches instead of starting a second engine', async () => {
    const h = new DownloadsHarness();
    const { conversationIds } = await h.startOk(['https://a.com/holder']);
    const holder = conversationIds[0] ?? '';
    const slow = await launching(h);
    // Keep the mutex busy (a kill that hangs) so the launch cannot commit.
    h.processes.terminateBehavior = 'hang';
    void h.coordinator.pause(holder);
    await settleMicrotasks();
    h.workspace.gate = null;
    slow.release().catch(() => undefined);
    await settleMicrotasks();

    const spawned = h.processes.last();
    assert.equal(h.record(slow.id).status, 'running', 'persisted right after the spawn');
    assert.equal(h.record(slow.id).process?.pid, spawned.identity.pid);

    // Crash: a new host over the same database, the engines still alive.
    const processes = new FakeProcessHost(h.logs);
    for (const process of h.processes.running()) processes.external.set(process.identity.pid, true);
    const next = new DownloadsHarness({ persistence: h.persistence, logs: h.logs, processes });
    await next.coordinator.initialize();
    await next.whenIdle();
    assert.equal(next.processes.processes.length, 0, 'no duplicate engine');
    assert.ok(next.coordinator.snapshot().active.some((item) => item.conversationId === slow.id));
    h.processes.releaseTerminations();
  });

  it('a launch that throws fails only its own download', async () => {
    const h = new DownloadsHarness();
    h.engines.adapters['gallery-dl'].secretConfig = (url) => {
      if (url.includes('boom')) throw new Error('adapter bug');
      return null;
    };
    const { conversationIds } = await h.startOk(['https://a.com/ok', 'https://a.com/boom', 'https://a.com/ok2']);
    const [ok = '', boom = '', ok2 = ''] = conversationIds;
    assert.equal(h.record(ok).status, 'running');
    assert.equal(h.record(ok2).status, 'running');
    assert.equal(h.record(boom).status, 'failed');
    assert.equal(h.record(boom).outcome?.reason, 'spawn-failed');
    assert.equal(h.processes.processes.length, 2);
  });

  it('nothing launches while runtime tools are busy; reschedule() starts the queue afterwards', async () => {
    const h = new DownloadsHarness();
    h.runtimeBusy = true;
    const { conversationIds } = await h.startOk(['https://a.com/1']);
    const id = conversationIds[0] ?? '';
    assert.equal(h.record(id).status, 'pending');
    h.coordinator.reschedule();
    await h.whenIdle();
    assert.equal(h.processes.processes.length, 0);
    h.runtimeBusy = false;
    h.coordinator.reschedule();
    await h.whenIdle();
    assert.equal(h.record(id).status, 'running');
  });

  it('shutdown waits for a launch in flight and discards it, keeping the download queued', async () => {
    const h = new DownloadsHarness();
    const slow = await launching(h);
    const shutdown = h.coordinator.shutdown('pause');
    await settleMicrotasks();
    await slow.release();
    await shutdown;
    const process = h.processes.last();
    assert.equal(process.alive, false);
    const record = h.record(slow.id);
    assert.equal(record.status, 'pending');
    assert.equal(record.process, null);
    assert.ok(!h.persistence.events.codesOf(slow.id).includes('started'));
    assert.equal(h.timers.pending, 0);
  });

  it('detach shutdown commits a launch in flight as running for the next host', async () => {
    const h = new DownloadsHarness();
    const slow = await launching(h);
    const shutdown = h.coordinator.shutdown('detach');
    await settleMicrotasks();
    await slow.release();
    await shutdown;
    assert.equal(h.processes.last().alive, true);
    assert.equal(h.record(slow.id).status, 'running');
    assert.equal(h.record(slow.id).process?.pid, h.processes.last().identity.pid);
  });
});
