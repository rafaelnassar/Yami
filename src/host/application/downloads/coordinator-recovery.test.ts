import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crashedHost, secondHost } from './testing/crash.ts';
import { out } from './testing/fake-engines.ts';
import { InMemoryPersistence } from './testing/fake-persistence.ts';
import { DownloadsHarness } from './testing/harness.ts';

describe('DownloadCoordinator — re-attach after a host restart', () => {
  it('re-attaches to a live engine and tails its log from the persisted offset', async () => {
    const crashed = await crashedHost();
    assert.equal(crashed.persistence.downloads.get(crashed.id)?.logOffset, 1);
    const h = secondHost(crashed, { alive: true });
    await h.coordinator.initialize();
    await h.whenIdle();

    assert.deepEqual(h.logs.opened.at(-1), { file: crashed.logFile, offset: 1 });
    assert.equal(h.processes.processes.length, 0, 'no new process launched');
    assert.equal(h.coordinator.snapshot().active[0]?.conversationId, crashed.id);
    assert.ok(h.events.logs().some((entry) => entry.code === 'reattached'));

    // Output produced while the host was down is picked up; already stored files are not recounted.
    h.logs.append(crashed.logFile, [out.skipped('/dl/a.jpg'), out.file('/dl/b.jpg')]);
    await h.tick();
    assert.deepEqual(h.record(crashed.id).counters, { done: 2, skipped: 0, errors: 0 });

    h.processes.external.set(crashed.pid, false);
    await h.settle();
    const record = h.record(crashed.id);
    assert.equal(record.status, 'completed');
    assert.equal(record.outcome?.kind, 'ok');
    assert.equal(h.events.ofType('download.finished').length, 1);
  });

  it('finalizes a download whose engine died while the host was down', async () => {
    const crashed = await crashedHost();
    crashed.logs.append(crashed.logFile, [out.file('/dl/b.jpg'), out.error('HTTP 500', 'network')]);
    const h = secondHost(crashed, { alive: false });
    await h.coordinator.initialize();
    await h.whenIdle();
    const record = h.record(crashed.id);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.counters, { done: 2, skipped: 0, errors: 1 });
    assert.equal(record.outcome?.kind, 'partial');
    assert.equal(h.events.ofType('download.finished').length, 1);
    assert.equal(h.timers.pending, 0);
  });

  it('detects a reused PID with a strict check after stale polls', async () => {
    const crashed = await crashedHost();
    const h = secondHost(crashed, { alive: true, stale: 3 });
    await h.coordinator.initialize();
    h.processes.external.delete(crashed.pid);
    h.processes.reused.add(crashed.pid);
    await h.tick();
    await h.tick();
    assert.equal(h.record(crashed.id).status, 'running', 'non-strict polls cannot tell');
    await h.tick();
    assert.equal(h.record(crashed.id).status, 'completed');
    assert.equal(h.processes.strictChecks >= 2, true);
  });

  it('resumes the queue in its original order after quit: interrupted first, user-paused stay paused', async () => {
    const persistence = new InMemoryPersistence();
    const first = new DownloadsHarness({ persistence, options: { maxSlotWeight: 1 } });
    const { conversationIds } = await first.startOk(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    const [a = '', b = '', c = ''] = conversationIds;
    await first.coordinator.pause(c);
    await first.coordinator.shutdown('pause');
    assert.equal(first.record(a).status, 'pending', 'the running download goes back to the queue');
    assert.equal(first.record(a).position < first.record(b).position, true, 'at its original position');

    const h = new DownloadsHarness({ persistence, options: { maxSlotWeight: 1 } });
    await h.coordinator.initialize();
    await h.whenIdle();
    assert.equal(h.record(a).status, 'running', 'the interrupted download resumes first');
    assert.equal(h.record(b).status, 'pending');
    assert.equal(h.record(c).status, 'paused');
    await h.coordinator.initialize();
    assert.equal(h.processes.processes.length, 1, 'initialize is idempotent');
  });
});

describe('DownloadCoordinator — shutdown', () => {
  it('pause mode terminates engines and puts them back in the queue', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 2 } });
    const { conversationIds } = await h.startOk(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    const [a = '', , c = ''] = conversationIds;
    h.processes.processes[0]?.write(out.file('/dl/a.jpg'));
    await h.coordinator.shutdown('pause');

    assert.equal(h.processes.running().length, 0);
    assert.equal(h.record(a).status, 'pending');
    assert.equal(h.record(a).process, null);
    assert.equal(h.record(a).counters.done, 1);
    assert.equal(h.persistence.events.codesOf(a).at(-1), 'pausedOnExit');
    assert.equal(h.record(c).status, 'pending');
    assert.equal(h.timers.pending, 0);

    for (const command of ['pause', 'resume', 'stop', 'restart', 'forget'] as const) {
      const result = await h.coordinator[command](a);
      assert.equal(result.ok ? '' : result.error.code, 'HOST_SHUTTING_DOWN', command);
    }
    const start = await h.start(['https://a.com/4']);
    assert.equal(start.ok ? '' : start.error.code, 'HOST_SHUTTING_DOWN');
    assert.deepEqual(await h.coordinator.pauseAll(), { affected: 0 });
    await h.coordinator.shutdown('pause');
  });

  it('pause mode leaves an engine that cannot be terminated running, for re-attach', async () => {
    const h = new DownloadsHarness();
    const { conversationIds } = await h.startOk(['https://a.com/1']);
    h.processes.terminateBehavior = 'refuse';
    await h.coordinator.shutdown('pause');
    const record = h.record(conversationIds[0] ?? '');
    assert.equal(record.status, 'running');
    assert.ok(record.process);
  });

  it('detach mode leaves engines running with their offsets persisted', async () => {
    const h = new DownloadsHarness({ options: { persistEveryMs: 60_000 } });
    const { conversationIds } = await h.startOk(['https://a.com/1']);
    const id = conversationIds[0] ?? '';
    h.processes.last().write(out.file('/dl/a.jpg'), out.file('/dl/b.jpg'));
    await h.tick();
    await h.coordinator.shutdown('detach');
    assert.equal(h.processes.last().alive, true);
    const record = h.record(id);
    assert.equal(record.status, 'running');
    assert.equal(record.logOffset, 2);
    assert.deepEqual(record.counters, { done: 2, skipped: 0, errors: 0 });
    assert.equal(h.timers.pending, 0);
  });
});
