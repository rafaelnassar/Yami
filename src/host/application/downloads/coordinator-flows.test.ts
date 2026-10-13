import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { out } from './testing/fake-engines.ts';
import { LAUNCH_FAILED } from './testing/fake-processes.ts';
import { DownloadsHarness } from './testing/harness.ts';

async function started(
  urls: readonly string[] = ['https://site.com/gallery/cats']
): Promise<{ h: DownloadsHarness; id: string }> {
  const h = new DownloadsHarness();
  await h.coordinator.initialize();
  const { conversationIds } = await h.startOk(urls);
  return { h, id: conversationIds[0] ?? '' };
}

describe('DownloadCoordinator — start → finish', () => {
  it('start → running → completed (ok)', async () => {
    const { h, id } = await started();
    assert.equal(h.record(id).status, 'running');
    assert.equal(h.record(id).title, 'cats');
    assert.deepEqual(
      h.events.ofType('conversation.changed').map((e) => e.reason),
      ['created', 'started']
    );

    h.fileSystem.sizes.set('/dl/gallery-dl/a.jpg', 1234);
    h.processes.last().write(out.file('/dl/gallery-dl/a.jpg'), out.skipped('/dl/gallery-dl/b.jpg')).exit(0);
    await h.settle();

    const record = h.record(id);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.outcome, { kind: 'ok', reason: null, detail: null });
    assert.deepEqual(record.counters, { done: 1, skipped: 1, errors: 0 });
    assert.equal(record.process, null);
    assert.deepEqual(h.persistence.events.codesOf(id), ['created', 'started', 'completed']);

    const [file] = h.persistence.files.rows;
    assert.equal(file?.path, '/dl/gallery-dl/a.jpg');
    assert.equal(file?.sizeBytes, 1234);
    assert.equal(file?.mediaType, 'image');
    assert.equal(h.events.ofType('files.added')[0]?.items[0]?.name, 'a.jpg');

    const [finished] = h.events.ofType('download.finished');
    assert.equal(finished?.download.status, 'completed');
    assert.equal(finished?.download.title, 'cats');
    assert.equal(h.events.ofType('notice').length, 0);
    assert.equal(h.coordinator.hasActive(), false);
    assert.equal(h.coordinator.snapshot().status, 'idle');
    assert.deepEqual(h.workspace.cleanups, [{ id, removeLog: false }]);
    assert.equal(h.timers.pending, 0, 'supervision stops when nothing runs');
  });

  it('files downloaded with an error line → partial (completed), not failed', async () => {
    const { h, id } = await started();
    h.processes
      .last()
      .write(out.file('/dl/a.jpg'), out.error('HttpError: 404', 'not-found'), out.file('/dl/b.jpg'))
      .exit(1);
    await h.settle();
    const record = h.record(id);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.outcome, { kind: 'partial', reason: 'not-found', detail: 'HttpError: 404' });
    assert.deepEqual(record.counters, { done: 2, skipped: 0, errors: 1 });
    assert.deepEqual(record.errorLines, ['HttpError: 404']);
    assert.equal(h.persistence.events.rows.at(-1)?.code, 'completedWithErrors');
    assert.equal(h.events.ofType('notice').length, 0);
  });

  it('nothing produced → empty (failed) with a notice', async () => {
    const { h, id } = await started();
    h.processes.last().write(out.info('nothing here')).exit(0);
    await h.settle();
    const record = h.record(id);
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.outcome, { kind: 'empty', reason: 'empty-result', detail: null });
    const [notice] = h.events.ofType('notice');
    assert.equal(notice?.notice.id, `download-failed-${id}`);
    assert.equal(notice?.notice.code, 'downloadFailed');
    assert.deepEqual(notice?.notice.params, {
      engine: 'gallery-dl',
      title: 'cats',
      reason: 'empty-result',
      detail: ''
    });
  });

  it('fatal error and nothing produced → error with the error kind; non-zero exit alone → exit-code', async () => {
    const { h, id } = await started();
    h.processes.last().write(out.error('refresh-token required', 'pixiv-auth')).exit(1);
    await h.settle();
    assert.deepEqual(h.record(id).outcome, { kind: 'error', reason: 'pixiv-auth', detail: 'refresh-token required' });

    const second = await h.startOk(['https://site.com/x']);
    h.processes.last().exit(2);
    await h.settle();
    assert.deepEqual(h.record(second.conversationIds[0] ?? '').outcome, {
      kind: 'error',
      reason: 'exit-code',
      detail: 'exit 2'
    });
  });

  it('refuses to start when the engine is unavailable (no blocking auto-install)', async () => {
    const h = new DownloadsHarness();
    h.tools.missing.add('yt-dlp');
    const result = await h.start(['https://youtube.com/watch?v=x'], { engine: 'yt-dlp' });
    assert.deepEqual(result, { ok: false, error: { code: 'ENGINE_UNAVAILABLE', params: { engine: 'yt-dlp' } } });
    assert.equal(h.persistence.downloads.rows.size, 0);
  });

  it('engine removed before launch → failed engine-missing, with finished events', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 1 } });
    const { conversationIds } = await h.startOk(['https://a.com/1', 'https://a.com/2']);
    const [, second = ''] = conversationIds;
    h.tools.missing.add('gallery-dl');
    h.processes.last().exit(0);
    await h.settle();
    const record = h.record(second);
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.outcome, { kind: 'error', reason: 'engine-missing', detail: null });
    assert.equal(h.persistence.events.rows.at(-1)?.code, 'failedEngineMissing');
    assert.ok(
      h.events.ofType('conversation.changed').some((e) => e.conversationId === second && e.reason === 'finished')
    );
  });

  it('spawn and workspace failures fail the download with their reason', async () => {
    const h = new DownloadsHarness();
    h.processes.launchError = LAUNCH_FAILED;
    const spawn = await h.startOk(['https://a.com/1']);
    assert.deepEqual(h.record(spawn.conversationIds[0] ?? '').outcome, {
      kind: 'error',
      reason: 'spawn-failed',
      detail: 'spawn ENOENT'
    });

    h.processes.launchError = null;
    h.workspace.failPrepare = true;
    const workspace = await h.startOk(['https://a.com/2']);
    const outcome = h.record(workspace.conversationIds[0] ?? '').outcome;
    assert.equal(outcome?.reason, 'workspace-failed');
    assert.ok(!outcome?.detail?.includes('/data/work'), 'private paths are redacted');
  });

  it('assigns the folder and validates the request', async () => {
    const h = new DownloadsHarness();
    h.persistence.folders.save({ id: 'f1', name: 'F', color: '#ffffff', collapsed: false, position: 0, createdAt: 0 });
    const { conversationIds } = await h.startOk(['https://a.com/1'], { folderId: 'f1' });
    assert.equal(h.persistence.folders.assignments.get(conversationIds[0] ?? ''), 'f1');
    assert.equal(h.record(conversationIds[0] ?? '').folderId, 'f1');

    const invalid = await h.start(['ftp://a.com/x']);
    assert.equal(invalid.ok ? '' : invalid.error.code, 'URL_INVALID');
    const empty = await h.start([]);
    assert.equal(empty.ok ? '' : empty.error.code, 'VALIDATION_FAILED');
    const stale = await h.startOk(['https://a.com/2'], { folderId: 'gone' });
    assert.equal(h.record(stale.conversationIds[0] ?? '').folderId, null);
  });
});

describe('DownloadCoordinator — supervision', () => {
  it('snapshot progress is per download', async () => {
    const h = new DownloadsHarness();
    const { conversationIds } = await h.startOk(['https://youtube.com/watch?v=a', 'https://youtube.com/watch?v=b'], {
      engine: 'yt-dlp'
    });
    const [first, second] = h.processes.processes;
    first?.write(out.progress(10, '1MiB/s', '00:30'), out.file('/dl/yt-dlp/a.mp4'));
    second?.write(out.progress(75, '3MiB/s', '00:05'));
    await h.tick();

    const snapshot = h.coordinator.snapshot();
    assert.equal(snapshot.status, 'running');
    const byId = new Map(snapshot.active.map((item) => [item.conversationId, item]));
    assert.equal(byId.get(conversationIds[0] ?? '')?.percent, 10);
    assert.equal(byId.get(conversationIds[0] ?? '')?.currentFile, '/dl/yt-dlp/a.mp4');
    assert.deepEqual(byId.get(conversationIds[0] ?? '')?.counters, { done: 1, skipped: 0, errors: 0 });
    assert.equal(byId.get(conversationIds[1] ?? '')?.percent, 75);
    assert.equal(byId.get(conversationIds[1] ?? '')?.speed, '3MiB/s');
    assert.equal(byId.get(conversationIds[1] ?? '')?.currentFile, null);
    assert.deepEqual(snapshot.batch?.counters, { done: 1, skipped: 0, errors: 0 });
  });

  it('notifies change listeners on progress and stops notifying after unsubscribe', async () => {
    const { h } = await started();
    let calls = 0;
    const unsubscribe = h.coordinator.onChange(() => {
      calls += 1;
    });
    h.processes.last().write(out.file('/dl/a.jpg'));
    await h.tick();
    assert.ok(calls > 0);
    unsubscribe();
    const before = calls;
    h.processes.last().write(out.file('/dl/b.jpg'));
    await h.tick();
    assert.equal(calls, before);
  });

  it('resolves relative paths and ignores engine temp files', async () => {
    const { h, id } = await started();
    h.processes
      .last()
      .write(
        out.file('./gallery-dl/rel.jpg'),
        out.file(`/data/work/${id}/tmp/video.f137.mp4`),
        out.pending(`/data/work/${id}/tmp/video.mp4`),
        out.promote()
      )
      .exit(0);
    await h.settle();
    assert.deepEqual(
      h.persistence.files.rows.map((row) => row.path),
      ['/dl/gallery-dl/rel.jpg']
    );
    assert.equal(h.record(id).counters.done, 1);
  });

  it('promotes a pending yt-dlp destination once post-processing ends', async () => {
    const { h, id } = await started();
    h.processes.last().write(out.pending('/dl/yt-dlp/v.mp4'), out.progress(100), out.promote()).exit(0);
    await h.settle();
    assert.deepEqual(h.record(id).counters, { done: 1, skipped: 0, errors: 0 });
    assert.equal(h.persistence.files.rows[0]?.path, '/dl/yt-dlp/v.mp4');
  });

  it('persists counters and log offset at most every persistEveryMs, but at once with new files', async () => {
    const h = new DownloadsHarness({ options: { persistEveryMs: 5000, pollMinMs: 1000, pollMaxMs: 1000 } });
    const { conversationIds } = await h.startOk(['https://a.com/1']);
    const id = conversationIds[0] ?? '';
    const saves = (): number => h.persistence.downloads.saves;
    const base = saves();
    for (let i = 0; i < 4; i += 1) {
      h.processes.last().write(out.progress(i * 10));
      await h.tick();
    }
    assert.equal(saves() - base, 0, 'no save within the throttle window');
    h.processes.last().write(out.progress(50));
    await h.tick();
    assert.equal(saves() - base, 1);
    assert.equal(h.record(id).logOffset, 5);

    // A file row and the counters/offset that account for it are stored together.
    h.processes.last().write(out.file('/dl/a.jpg'));
    await h.tick();
    assert.equal(saves() - base, 2);
    assert.equal(h.record(id).counters.done, 1);
    assert.equal(h.record(id).logOffset, 6);
    assert.equal(h.persistence.files.rows.length, 1);
  });

  it('never publishes secrets: tokens, cookie paths and private dirs are redacted', async () => {
    const h = new DownloadsHarness();
    h.credentials.pixiv = { refreshToken: 'SECRET-REFRESH-TOKEN', userName: 'u', userId: '1', savedAt: 0 };
    await h.cookieVault.save('pixiv.txt', 'cookie-data');
    const { conversationIds } = await h.startOk(['https://www.pixiv.net/users/1?token=QUERYSECRET'], {
      cookieNames: ['pixiv.txt']
    });
    const id = conversationIds[0] ?? '';
    assert.equal(
      h.workspace.privateFiles.get(`/data/work/${id}/engine-secrets.conf`)?.includes('SECRET-REFRESH-TOKEN'),
      true
    );
    const args = h.processes.last().spec.args;
    assert.ok(!args.some((arg) => arg.includes('SECRET-REFRESH-TOKEN')), 'token never on the command line');

    h.processes
      .last()
      .write(
        out.info('using extractor.pixiv.refresh-token=SECRET-REFRESH-TOKEN'),
        out.error(`cookie file /data/work/${id}/pixiv.txt rejected`, 'cookies-auth')
      )
      .exit(1);
    await h.settle();

    // `download.finished.sourceUrl` is the conversation URL itself (as in the history list);
    // log lines and notices must never carry secrets.
    const text = JSON.stringify([...h.events.ofType('log'), ...h.events.ofType('notice')]);
    for (const secret of ['SECRET-REFRESH-TOKEN', 'QUERYSECRET', '/data/work']) {
      assert.ok(!text.includes(secret), `published logs/notices leak ${secret}`);
    }
    assert.ok(!h.events.publishedText().includes('SECRET-REFRESH-TOKEN'));
    const [cmd] = h.events.logs().filter((entry) => entry.level === 'cmd');
    assert.match(cmd?.text ?? '', /^> gallery-dl .*--cookies \[redacted\]/);
    assert.ok(!JSON.stringify(h.record(id)).includes('/data/work'), 'stored error lines are redacted too');
    assert.deepEqual(h.cookieVault.absorbed, [{ name: 'pixiv.txt', file: `/data/work/${id}/pixiv.txt` }]);
  });
});
