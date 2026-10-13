import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { out } from './testing/fake-engines.ts';
import { FakeJobWorkspace } from './testing/fake-files.ts';
import { LAUNCH_FAILED } from './testing/fake-processes.ts';
import { DownloadsHarness } from './testing/harness.ts';

async function running(h = new DownloadsHarness(), url = 'https://youtube.com/watch?v=1') {
  await h.coordinator.initialize();
  const { conversationIds } = await h.startOk([url], { engine: 'yt-dlp' });
  return { h, id: conversationIds[0] ?? '' };
}

describe('DownloadCoordinator — job workspace across runs', () => {
  it('engines get the per-run secrets dir (wiped at every run end) apart from the kept temp dir', async () => {
    const h = new DownloadsHarness();
    const { id } = await running(h, 'https://www.pixiv.net/artworks/1');
    const context = h.engines.adapters['yt-dlp'].contexts.at(-1);
    assert.equal(context?.secretDir, FakeJobWorkspace.pathsOf(id).dir);
    assert.equal(context?.tempDir, FakeJobWorkspace.pathsOf(id).tempDir);
  });

  it('pause removes only the secrets: the temp dir survives, resume reuses it and the end retires it', async () => {
    const { h, id } = await running();
    assert.equal((await h.coordinator.pause(id)).ok, true);
    assert.deepEqual(h.workspace.secretRemovals, [id]);
    assert.deepEqual(h.workspace.cleanups, [], 'partial files are not deleted by a pause');

    assert.equal((await h.coordinator.resume(id)).ok, true);
    await h.whenIdle();
    assert.deepEqual(h.workspace.prepared, [id, id]);
    const contexts = h.engines.adapters['yt-dlp'].contexts;
    assert.equal(contexts.at(-1)?.tempDir, contexts[0]?.tempDir, 'same temp dir: partial files are continued');

    h.processes.last().write(out.file('/dl/v.mp4')).exit(0);
    await h.settle();
    assert.equal(h.record(id).status, 'completed');
    assert.deepEqual(h.workspace.cleanups, [{ id, removeLog: false }]);
  });

  it('app quit (shutdown pause) keeps the temp files of the interrupted downloads', async () => {
    const { h, id } = await running();
    await h.coordinator.shutdown('pause');
    assert.equal(h.record(id).status, 'pending');
    assert.deepEqual(h.workspace.secretRemovals, [id]);
    assert.deepEqual(h.workspace.cleanups, []);
  });

  it('a cookie retry keeps the temp files; only the final outcome retires the job', async () => {
    const h = new DownloadsHarness();
    h.persistence.settings.patchCookies({ fromBrowser: true });
    const { id } = await running(h);
    h.processes.last().write(out.error('Could not copy Chrome cookie database', 'cookie-copy')).exit(1);
    await h.settle();
    assert.equal(h.processes.processes.length, 2, 'retried');
    assert.deepEqual(h.workspace.secretRemovals, [id]);
    assert.deepEqual(h.workspace.cleanups, []);
    h.processes.last().write(out.file('/dl/v.mp4')).exit(0);
    await h.settle();
    assert.deepEqual(h.workspace.cleanups, [{ id, removeLog: false }]);
  });

  it('stop retires the workspace, running or paused (temp files are not needed any more)', async () => {
    const { h, id } = await running();
    assert.equal((await h.coordinator.stop(id)).ok, true);
    assert.deepEqual(h.workspace.cleanups, [{ id, removeLog: false }]);

    const other = await running(new DownloadsHarness());
    assert.equal((await other.h.coordinator.pause(other.id)).ok, true);
    assert.equal((await other.h.coordinator.stop(other.id)).ok, true);
    assert.deepEqual(other.h.workspace.cleanups, [{ id: other.id, removeLog: false }]);
  });

  it('a launch failure removes the secrets it wrote and retires the failed download', async () => {
    const h = new DownloadsHarness();
    h.processes.launchError = LAUNCH_FAILED;
    const { id } = await running(h);
    assert.equal(h.record(id).status, 'failed');
    assert.deepEqual(h.workspace.secretRemovals, [id]);
    assert.deepEqual(h.workspace.cleanups, [{ id, removeLog: false }]);
  });

  it('a row deleted without forget retires the job with its log (nothing left to show it)', async () => {
    const { h, id } = await running();
    h.persistence.downloads.delete(id);
    h.processes.last().write(out.file('/dl/v.mp4')).exit(0);
    await h.settle();
    assert.deepEqual(h.workspace.cleanups, [{ id, removeLog: true }]);
  });
});

describe('DownloadCoordinator — an engine killed from outside is not a success', () => {
  it('files produced, no error line, killed by a signal or a non-zero exit → partial exit-code', async () => {
    for (const [code, signal, detail] of [
      [null, 'SIGKILL', 'signal SIGKILL'],
      [1, null, 'exit 1']
    ] as const) {
      const { h, id } = await running(new DownloadsHarness(), 'https://site.com/gallery');
      h.processes.last().write(out.file('/dl/1.jpg'), out.file('/dl/2.jpg')).exit(code, signal);
      await h.settle();
      const record = h.record(id);
      assert.equal(record.status, 'completed', detail);
      assert.deepEqual(record.outcome, { kind: 'partial', reason: 'exit-code', detail }, detail);
      assert.equal(h.persistence.events.rows.at(-1)?.code, 'completedInterrupted', detail);
      assert.equal(h.events.ofType('download.finished')[0]?.download.outcome.kind, 'partial', detail);
    }
  });

  it('user pause and stop keep their own outcomes (the kill is not judged by its signal)', async () => {
    const paused = await running();
    paused.h.processes.last().write(out.file('/dl/1.jpg'));
    assert.equal((await paused.h.coordinator.pause(paused.id)).ok, true);
    await paused.h.settle();
    assert.equal(paused.h.record(paused.id).status, 'paused');
    assert.equal(paused.h.record(paused.id).outcome, null);

    const stopped = await running();
    stopped.h.processes.last().write(out.file('/dl/1.jpg'));
    assert.equal((await stopped.h.coordinator.stop(stopped.id)).ok, true);
    await stopped.h.settle();
    assert.deepEqual(stopped.h.record(stopped.id).outcome, { kind: 'cancelled', reason: null, detail: null });
  });
});
