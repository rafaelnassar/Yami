import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { out } from './testing/fake-engines.ts';
import { DownloadsHarness } from './testing/harness.ts';

async function running(options: ConstructorParameters<typeof DownloadsHarness>[0] = {}) {
  const h = new DownloadsHarness(options);
  await h.coordinator.initialize();
  const { conversationIds } = await h.startOk(['https://site.com/a']);
  return { h, id: conversationIds[0] ?? '' };
}

function codeOf(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  return result.ok ? 'ok' : (result.error?.code ?? '');
}

describe('DownloadCoordinator — pause / resume', () => {
  it('pause kills the engine, records what it printed, and resume re-queues it', async () => {
    const { h, id } = await running();
    const first = h.processes.last();
    first.write(out.file('/dl/a.jpg'));

    assert.equal(codeOf(await h.coordinator.pause(id)), 'ok');
    await h.whenIdle();
    assert.equal(first.alive, false);
    assert.deepEqual(h.processes.terminated, [first.identity.pid]);
    const paused = h.record(id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.process, null);
    assert.equal(paused.counters.done, 1, 'lines written before the kill are counted');
    assert.equal(h.persistence.events.rows.at(-1)?.code, 'paused');
    assert.equal(h.coordinator.snapshot().status, 'paused');
    assert.equal(h.coordinator.hasActive(), false, 'paused downloads do not block tool updates');
    assert.equal(codeOf(await h.coordinator.pause(id)), 'ok', 'pausing twice is a no-op');

    assert.equal(codeOf(await h.coordinator.resume(id)), 'ok');
    await h.whenIdle();
    assert.equal(h.processes.processes.length, 2, 'resume launches a new run');
    assert.equal(h.record(id).status, 'running');
    assert.deepEqual(h.persistence.events.codesOf(id).slice(-2), ['resumed', 'started']);

    // The engine re-reports the already downloaded file as skipped: not double counted.
    h.processes.last().write(out.skipped('/dl/a.jpg'), out.file('/dl/b.jpg')).exit(0);
    await h.settle();
    assert.deepEqual(h.record(id).counters, { done: 2, skipped: 0, errors: 0 });
    assert.equal(h.record(id).status, 'completed');
  });

  it('pausing a pending download does not launch it', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 1 } });
    const { conversationIds } = await h.startOk(['https://a.com/1', 'https://a.com/2']);
    const second = conversationIds[1] ?? '';
    assert.equal(codeOf(await h.coordinator.pause(second)), 'ok');
    assert.equal(h.persistence.events.rows.at(-1)?.code, 'pausedBeforeStart');
    h.processes.last().exit(0);
    await h.settle();
    assert.equal(h.processes.processes.length, 1);
    assert.equal(h.record(second).status, 'paused');
  });

  it('a failed kill returns PROCESS_KILL_FAILED and leaves the download running', async () => {
    const { h, id } = await running();
    h.processes.terminateBehavior = 'refuse';
    assert.equal(codeOf(await h.coordinator.pause(id)), 'PROCESS_KILL_FAILED');
    assert.equal(codeOf(await h.coordinator.stop(id)), 'PROCESS_KILL_FAILED');
    h.processes.terminateBehavior = 'throw';
    assert.equal(codeOf(await h.coordinator.pause(id)), 'PROCESS_KILL_FAILED');
    assert.equal(h.record(id).status, 'running');
    assert.ok(h.record(id).process);
    // still supervised
    h.processes.last().write(out.file('/dl/a.jpg')).exit(0);
    await h.settle();
    assert.equal(h.record(id).status, 'completed');
  });

  it('pausing a download whose exit was already delivered finishes it normally', async () => {
    const { h, id } = await running();
    h.processes.last().write(out.file('/dl/a.jpg')).exit(0); // exit delivered, supervision pass not run yet
    assert.equal(codeOf(await h.coordinator.pause(id)), 'ok');
    assert.equal(h.record(id).status, 'completed');
    assert.deepEqual(h.processes.terminated, []);
  });

  it('pause asks the terminator directly, without a strict identity read first', async () => {
    const { h, id } = await running();
    h.processes.last().alive = false; // died, exit not delivered yet: terminate() reports it gone
    assert.equal(codeOf(await h.coordinator.pause(id)), 'ok');
    assert.equal(h.record(id).status, 'paused');
    assert.equal(h.processes.strictChecks, 0, 'no OS identity read when termination succeeds');
  });
});

describe('DownloadCoordinator — stop / restart', () => {
  it('stop cancels a running download without download.finished', async () => {
    const { h, id } = await running();
    assert.equal(codeOf(await h.coordinator.stop(id)), 'ok');
    const record = h.record(id);
    assert.equal(record.status, 'cancelled');
    assert.deepEqual(record.outcome, { kind: 'cancelled', reason: null, detail: null });
    assert.equal(h.persistence.events.rows.at(-1)?.code, 'interrupted');
    assert.equal(h.events.ofType('download.finished').length, 0);
    assert.equal(h.coordinator.hasActive(), false);
    assert.equal(codeOf(await h.coordinator.stop(id)), 'DOWNLOAD_NOT_ACTIVE');
  });

  it('stop of pending and paused downloads cancels them', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 1 } });
    const { conversationIds } = await h.startOk(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    const [, pending = '', paused = ''] = conversationIds;
    await h.coordinator.pause(paused);
    assert.equal(codeOf(await h.coordinator.stop(pending)), 'ok');
    assert.equal(codeOf(await h.coordinator.stop(paused)), 'ok');
    assert.equal(h.persistence.events.codesOf(pending).at(-1), 'cancelled');
    assert.equal(h.record(paused).status, 'cancelled');
  });

  it('restart resets counters, outcome, errors and retry flags, and requeues at the end', async () => {
    const { h, id } = await running();
    h.processes.last().write(out.file('/dl/a.jpg'), out.error('boom', 'network')).exit(1);
    await h.settle();
    assert.equal(h.record(id).status, 'completed');
    const oldPosition = h.record(id).position;

    assert.equal(codeOf(await h.coordinator.restart(id)), 'ok');
    assert.equal(h.record(id).status, 'pending');
    await h.whenIdle();
    const restarted = h.record(id);
    assert.equal(restarted.status, 'running');
    assert.deepEqual(restarted.counters, { done: 0, skipped: 0, errors: 0 });
    assert.equal(restarted.outcome, null);
    assert.deepEqual(restarted.errorLines, []);
    assert.ok(restarted.position > oldPosition);
    assert.ok(h.persistence.events.codesOf(id).includes('restarted'));

    // Files from the previous run are recounted (as skipped) instead of ignored.
    h.processes.last().write(out.skipped('/dl/a.jpg')).exit(0);
    await h.settle();
    assert.deepEqual(h.record(id).counters, { done: 0, skipped: 1, errors: 0 });
    assert.equal(h.record(id).outcome?.kind, 'ok');
  });

  it('restart guards: active → DOWNLOAD_STILL_ACTIVE, unknown → CONVERSATION_NOT_FOUND, engine gone → ENGINE_UNAVAILABLE', async () => {
    const { h, id } = await running();
    assert.equal(codeOf(await h.coordinator.restart(id)), 'DOWNLOAD_STILL_ACTIVE');
    assert.equal(codeOf(await h.coordinator.restart('nope')), 'CONVERSATION_NOT_FOUND');
    await h.coordinator.stop(id);
    h.tools.missing.add('gallery-dl');
    assert.equal(codeOf(await h.coordinator.restart(id)), 'ENGINE_UNAVAILABLE');
  });

  it('unknown ids and wrong states return typed errors', async () => {
    const { h, id } = await running();
    for (const command of ['pause', 'resume', 'stop'] as const) {
      assert.equal(codeOf(await h.coordinator[command]('missing')), 'CONVERSATION_NOT_FOUND');
    }
    assert.equal(codeOf(await h.coordinator.resume(id)), 'DOWNLOAD_NOT_PAUSED');
    await h.coordinator.stop(id);
    assert.equal(codeOf(await h.coordinator.pause(id)), 'DOWNLOAD_NOT_ACTIVE');
    assert.equal(codeOf(await h.coordinator.resume(id)), 'DOWNLOAD_NOT_PAUSED');
  });
});

describe('DownloadCoordinator — bulk commands and forget', () => {
  it('pauseAll / resumeAll / stopAll return affected counts', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 2 } });
    await h.startOk(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    assert.deepEqual(await h.coordinator.pauseAll(), { affected: 3 });
    assert.equal(h.processes.running().length, 0);
    assert.deepEqual(await h.coordinator.pauseAll(), { affected: 0 });
    assert.deepEqual(await h.coordinator.resumeAll(), { affected: 3 });
    await h.whenIdle();
    assert.equal(h.processes.running().length, 2);
    assert.deepEqual(await h.coordinator.stopAll(), { affected: 3 });
    assert.equal(h.coordinator.hasActive(), false);
    assert.ok(h.events.logs().some((entry) => entry.code === 'stoppedAll' && entry.params['count'] === 3));
  });

  it('forget terminates, drops supervision and removes the job log, keeping rows for the caller', async () => {
    const { h, id } = await running();
    const process = h.processes.last();
    const result = await h.coordinator.forget(id);
    assert.deepEqual(result, { ok: true, value: undefined });
    assert.equal(process.alive, false);
    assert.equal(h.coordinator.hasActive(), false);
    assert.deepEqual(h.workspace.cleanups.at(-1), { id, removeLog: true });
    assert.ok(h.persistence.downloads.get(id), 'rows are deleted by the caller');
    h.persistence.downloads.delete(id);
    await h.settle();
    assert.equal(h.persistence.downloads.get(id), null, 'never resurrected');

    const killFails = await running();
    killFails.h.processes.terminateBehavior = 'refuse';
    assert.equal(codeOf(await killFails.h.coordinator.forget(killFails.id)), 'PROCESS_KILL_FAILED');
    assert.equal(killFails.h.coordinator.hasActive(), true);
  });

  it('a row deleted without forget is dropped instead of resurrected', async () => {
    const { h, id } = await running();
    h.persistence.downloads.delete(id);
    h.processes.last().write(out.file('/dl/a.jpg')).exit(0);
    await h.settle();
    assert.equal(h.persistence.downloads.get(id), null);
    assert.equal(h.coordinator.hasActive(), false);
  });
});
