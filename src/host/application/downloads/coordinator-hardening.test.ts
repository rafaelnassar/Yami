import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { out } from './testing/fake-engines.ts';
import { DownloadsHarness } from './testing/harness.ts';

async function running(h = new DownloadsHarness(), url = 'https://site.com/a?token=SECRET') {
  await h.coordinator.initialize();
  const { conversationIds } = await h.startOk([url]);
  return { h, id: conversationIds[0] ?? '' };
}

function codeOf(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  return result.ok ? 'ok' : (result.error?.code ?? '');
}

describe('DownloadCoordinator — engine paths are untrusted', () => {
  it('drops paths outside the download dir before any stat or insert', async () => {
    const { h, id } = await running();
    h.processes
      .last()
      .write(
        out.file('/etc/passwd'),
        out.file('/dl/../etc/shadow'),
        out.file('../outside.jpg'),
        out.pending('/home/user/.ssh/id_rsa'),
        out.promote(),
        out.skipped('/var/other.jpg'),
        out.file('/dl/gallery-dl/ok.jpg')
      )
      .exit(0);
    await h.settle();
    assert.deepEqual(h.fileSystem.statCalls, ['/dl/gallery-dl/ok.jpg']);
    assert.deepEqual(
      h.persistence.files.rows.map((row) => row.path),
      ['/dl/gallery-dl/ok.jpg']
    );
    assert.deepEqual(h.record(id).counters, { done: 1, skipped: 0, errors: 0 });
    assert.ok(h.events.logs().some((entry) => entry.level === 'warn' && entry.text?.includes('/etc/passwd')));
  });

  it('Windows: rejects UNC and device paths unless the download dir itself is UNC', async () => {
    const h = new DownloadsHarness({ options: { platform: 'win32' } });
    h.sandbox.downloadDir = 'C:\\dl';
    const { id } = await running(h);
    h.processes
      .last()
      .write(
        out.file('\\\\attacker\\share\\a.jpg'),
        out.file('\\\\?\\C:\\dl\\b.jpg'),
        out.file('C:\\dl\\c.jpg:hidden'),
        out.file('c:/DL/gallery-dl/d.jpg')
      )
      .exit(0);
    await h.settle();
    assert.deepEqual(h.fileSystem.statCalls, ['c:/DL/gallery-dl/d.jpg']);
    assert.equal(h.record(id).counters.done, 1);

    const unc = new DownloadsHarness({ options: { platform: 'win32' } });
    unc.sandbox.downloadDir = '\\\\nas\\media';
    const second = await running(unc);
    unc.processes
      .last()
      .write(out.file('\\\\nas\\media\\gallery-dl\\e.jpg'), out.file('\\\\nas\\other\\f.jpg'))
      .exit(0);
    await unc.settle();
    assert.deepEqual(unc.fileSystem.statCalls, ['\\\\nas\\media\\gallery-dl\\e.jpg']);
    assert.equal(unc.record(second.id).counters.done, 1);
  });
});

describe('DownloadCoordinator — downloaded file marks', () => {
  it('marks every downloaded file with the source URL stripped of secrets; failures are only logged', async () => {
    const { h } = await running();
    h.processes.last().write(out.file('/dl/a.jpg'), out.skipped('/dl/b.jpg'), out.file('/etc/c.jpg'));
    await h.tick();
    assert.deepEqual(h.fileMarker.marked, [{ path: '/dl/a.jpg', sourceUrl: 'https://site.com/a' }]);

    h.fileMarker.fail = true;
    h.processes.last().write(out.file('/dl/d.jpg')).exit(0);
    await h.settle();
    assert.equal(h.persistence.files.rows.length, 2);
    assert.ok(h.logger.records.some((record) => record.message === 'marking downloaded file failed'));
  });
});

describe('DownloadCoordinator — command edge cases', () => {
  it('stop and pause still apply when the exited engine was requeued for a cookie retry', async () => {
    for (const command of ['stop', 'pause'] as const) {
      const h = new DownloadsHarness();
      h.persistence.settings.patchCookies({ fromBrowser: true });
      const { conversationIds } = await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
      const id = conversationIds[0] ?? '';
      h.processes.last().write(out.error('Could not copy Chrome cookie database', 'cookie-copy')).exit(1);
      assert.equal(codeOf(await h.coordinator[command](id)), 'ok');
      await h.settle();
      assert.equal(h.processes.processes.length, 1, `${command}: never relaunched`);
      assert.equal(h.record(id).status, command === 'stop' ? 'cancelled' : 'paused');
    }
  });

  it('a forgotten download answers CONVERSATION_NOT_FOUND and is never adopted or scheduled again', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 1 } });
    const { conversationIds } = await h.startOk(['https://a.com/1', 'https://a.com/2']);
    const [first = '', second = ''] = conversationIds;
    assert.deepEqual(await h.coordinator.forget(second), { ok: true, value: undefined });
    // The caller has not deleted the row yet: it must not come back.
    for (const command of ['pause', 'resume', 'stop', 'restart', 'forget'] as const) {
      assert.equal(codeOf(await h.coordinator[command](second)), 'CONVERSATION_NOT_FOUND', command);
    }
    h.processes.last().exit(0);
    await h.settle();
    assert.equal(h.record(first).status, 'failed');
    assert.equal(h.processes.processes.length, 1, 'the forgotten download never started');
    assert.equal(h.record(second).status, 'pending', 'its row is left for the caller to delete');
  });
});

describe('DownloadCoordinator — event ordering and volume', () => {
  it('publishes download.finished only after the snapshot change was notified', async () => {
    const { h } = await running();
    const notified: { readonly at: number; readonly active: number }[] = [];
    h.coordinator.onChange(() =>
      notified.push({ at: h.events.events.length, active: h.coordinator.snapshot().active.length })
    );
    h.processes.last().write(out.file('/dl/a.jpg')).exit(0);
    await h.settle();
    const finishedAt = h.events.events.findIndex((event) => event.type === 'download.finished');
    assert.ok(finishedAt >= 0);
    const settled = notified.find((mark) => mark.active === 0);
    assert.ok(settled && settled.at <= finishedAt, 'the state without the download precedes its completion');
  });

  it('splits a big drain into log and files.added events of at most 500 items', async () => {
    const { h, id } = await running();
    const lines = Array.from({ length: 1200 }, (_, i) => out.file(`/dl/gallery-dl/${i}.jpg`));
    h.processes
      .last()
      .write(...lines)
      .exit(0);
    await h.settle();
    assert.equal(h.record(id).counters.done, 1200);
    const logs = h.events.ofType('log');
    const files = h.events.ofType('files.added');
    assert.ok(logs.every((event) => event.entries.length <= 500));
    assert.ok(files.every((event) => event.items.length <= 500));
    assert.equal(
      files.reduce((sum, event) => sum + event.items.length, 0),
      1200
    );
  });
});
