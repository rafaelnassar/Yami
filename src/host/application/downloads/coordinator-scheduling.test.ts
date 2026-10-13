import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { out } from './testing/fake-engines.ts';
import { gate } from './testing/fake-files.ts';
import { DownloadsHarness, settleMicrotasks } from './testing/harness.ts';

function urls(count: number, prefix = 'https://a.com/'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe('DownloadCoordinator — scheduling', () => {
  it('runs up to 8 gallery-dl downloads at once', async () => {
    const h = new DownloadsHarness();
    await h.startOk(urls(10));
    assert.equal(h.processes.running().length, 8);
    const snapshot = h.coordinator.snapshot();
    assert.equal(snapshot.active.length, 8);
    assert.deepEqual(
      snapshot.queued.map((item) => item.status),
      ['pending', 'pending']
    );
  });

  it('runs up to 4 yt-dlp downloads at once', async () => {
    const h = new DownloadsHarness();
    await h.startOk(urls(6, 'https://youtube.com/watch?v='), { engine: 'yt-dlp' });
    assert.equal(h.processes.running().length, 4);
  });

  it('starts the next queued download when one finishes, in position order', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 2 } });
    const { conversationIds } = await h.startOk(urls(4));
    assert.equal(h.processes.running().length, 2);
    h.processes.processes[0]?.write(out.file('/dl/x.jpg')).exit(0);
    await h.settle();
    assert.equal(h.processes.running().length, 2);
    assert.equal(h.record(conversationIds[2] ?? '').status, 'running');
    assert.equal(h.record(conversationIds[3] ?? '').status, 'pending');
  });

  it('lighter downloads overtake a heavier head that does not fit', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 3 } });
    await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
    const heavy = await h.startOk(['https://youtube.com/watch?v=2'], { engine: 'yt-dlp' });
    const light = await h.startOk(['https://a.com/1']);
    assert.equal(h.record(heavy.conversationIds[0] ?? '').status, 'pending');
    assert.equal(h.record(light.conversationIds[0] ?? '').status, 'running');
  });

  it('re-plans after launch failures free their slots', async () => {
    const h = new DownloadsHarness({ options: { maxSlotWeight: 2 } });
    await h.cookieVault.save('ok.txt', 'x');
    const result = await h.startOk(urls(4), { cookieNames: ['gone.txt', 'gone.txt', null, null] });
    const statuses = result.conversationIds.map((id) => h.record(id).status);
    assert.deepEqual(statuses, ['failed', 'failed', 'running', 'running']);
    assert.equal(h.record(result.conversationIds[0] ?? '').outcome?.reason, 'cookies-unavailable');
  });
});

describe('DownloadCoordinator — batches', () => {
  it('aggregates the newest active batch in the snapshot', async () => {
    const h = new DownloadsHarness();
    const first = await h.startOk(urls(2));
    h.clock.advance(10);
    const second = await h.startOk(urls(3, 'https://b.com/'));
    assert.equal(h.coordinator.snapshot().batch?.batchId, second.batchId);
    assert.equal(h.coordinator.snapshot().batch?.total, 3);
    for (const id of second.conversationIds) await h.coordinator.stop(id);
    const batch = h.coordinator.snapshot().batch;
    assert.equal(batch?.batchId, first.batchId);
    assert.equal(batch?.finished, 0);
  });

  it('publishes batch.finished exactly once, when every member is terminal', async () => {
    const h = new DownloadsHarness();
    const { batchId, conversationIds } = await h.startOk(urls(3));
    const [a, b] = h.processes.processes;
    a?.write(out.file('/dl/a.jpg')).exit(0);
    b?.exit(0);
    await h.settle();
    assert.equal(h.events.ofType('batch.finished').length, 0);
    assert.equal(h.coordinator.snapshot().batch?.finished, 2);

    await h.coordinator.stop(conversationIds[2] ?? '');
    const finished = h.events.ofType('batch.finished');
    assert.equal(finished.length, 1);
    assert.deepEqual(finished[0]?.batch, {
      batchId,
      engine: 'gallery-dl',
      total: 3,
      completed: 1,
      failed: 1,
      cancelled: 1
    });
    assert.ok(h.persistence.batches.get(batchId)?.notifiedAt);

    // A restarted member finishing later does not announce the batch again.
    await h.coordinator.restart(conversationIds[1] ?? '');
    await h.whenIdle();
    h.processes.last().write(out.file('/dl/b.jpg')).exit(0);
    await h.settle();
    assert.equal(h.events.ofType('batch.finished').length, 1);
    assert.equal(h.events.ofType('download.finished').length, 3);
  });

  it('single-URL batches are announced through download.finished only', async () => {
    const h = new DownloadsHarness();
    const { batchId } = await h.startOk(['https://a.com/1']);
    h.processes.last().write(out.file('/dl/a.jpg')).exit(0);
    await h.settle();
    assert.equal(h.events.ofType('batch.finished').length, 0);
    assert.ok(h.persistence.batches.get(batchId)?.notifiedAt, 'marked so it is never re-evaluated');
  });

  it('a forgotten member does not block the batch', async () => {
    const h = new DownloadsHarness();
    const { conversationIds } = await h.startOk(urls(2));
    h.processes.processes[0]?.exit(0);
    await h.settle();
    await h.coordinator.forget(conversationIds[1] ?? '');
    assert.equal(h.events.ofType('batch.finished')[0]?.batch.total, 1);
  });
});

describe('DownloadCoordinator — cookies', () => {
  it('resolves the cookie file: explicit → site binding → active → none', async () => {
    const h = new DownloadsHarness();
    await h.cookieVault.save('explicit.txt', 'x');
    await h.cookieVault.save('danbooru.txt', 'x');
    await h.cookieVault.save('global.txt', 'x');
    h.persistence.settings.patchCookies({
      active: 'global.txt',
      bindings: [
        { id: 'b1', siteHost: 'donmai.us', cookieName: 'danbooru.txt' },
        { id: 'b2', siteHost: 'example.org', cookieName: 'deleted.txt' }
      ]
    });
    await h.startOk(
      [
        'https://danbooru.donmai.us/posts/1',
        'https://danbooru.donmai.us/posts/2',
        'https://example.org/x',
        'https://other.net/y'
      ],
      { cookieNames: ['explicit.txt', null, null, null] }
    );
    assert.deepEqual(
      h.cookieVault.materialized.map((m) => m.name),
      ['explicit.txt', 'danbooru.txt', 'global.txt', 'global.txt']
    );
    h.persistence.settings.patchCookies({ active: null });
    await h.startOk(['https://other.net/z']);
    const context = h.engines.adapters['gallery-dl'].contexts.at(-1);
    assert.equal(context?.cookieFile, null);
  });

  it('commits engine cookie updates back to the vault after the run', async () => {
    const h = new DownloadsHarness();
    await h.cookieVault.save('site.txt', 'x');
    const { conversationIds } = await h.startOk(['https://site.com/a'], { cookieNames: ['site.txt'] });
    h.processes.last().write(out.file('/dl/a.jpg')).exit(0);
    await h.settle();
    const id = conversationIds[0] ?? '';
    assert.deepEqual(h.cookieVault.absorbed, [{ name: 'site.txt', file: `/data/work/${id}/site.txt` }]);
  });

  it('uses browser cookies for yt-dlp only with the opt-in and without a cookie file', async () => {
    const h = new DownloadsHarness();
    await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
    assert.equal(h.engines.adapters['yt-dlp'].contexts.at(-1)?.browserCookies, null);
    h.persistence.settings.patchCookies({ fromBrowser: true });
    await h.startOk(['https://youtube.com/watch?v=2'], { engine: 'yt-dlp' });
    assert.equal(h.engines.adapters['yt-dlp'].contexts.at(-1)?.browserCookies, 'chrome');
    assert.equal(h.record('id4').usedBrowserCookies, true);
    await h.startOk(['https://a.com/x']);
    assert.equal(h.engines.adapters['gallery-dl'].contexts.at(-1)?.browserCookies, null);
  });

  it('yt-dlp cookie retry: locked browser DB → retry without browser cookies, once', async () => {
    const h = new DownloadsHarness();
    h.persistence.settings.patchCookies({ fromBrowser: true });
    const { conversationIds } = await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
    const id = conversationIds[0] ?? '';
    h.processes.last().write(out.error('Could not copy Chrome cookie database', 'cookie-copy')).exit(1);
    await h.settle();

    assert.equal(h.processes.processes.length, 2, 'retried');
    assert.equal(h.record(id).status, 'running');
    assert.deepEqual(h.record(id).retry, { browserCookieMode: 'skip', skipTried: true, forceTried: false });
    assert.equal(h.engines.adapters['yt-dlp'].contexts.at(-1)?.browserCookies, null);
    assert.ok(h.persistence.events.codesOf(id).includes('retryWithoutBrowserCookies'));
    assert.equal(h.events.ofType('download.finished').length, 0, 'no completion for the discarded attempt');
    assert.equal(h.events.ofType('notice').length, 0);

    h.processes.last().write(out.error('Could not copy Chrome cookie database', 'cookie-copy')).exit(1);
    await h.settle();
    assert.equal(h.processes.processes.length, 2, 'no second retry of the same kind');
    assert.equal(h.record(id).status, 'failed');
  });

  it('yt-dlp cookie retry: bot check without browser cookies → retry with them (opt-in on)', async () => {
    const h = new DownloadsHarness();
    h.persistence.settings.patchCookies({ fromBrowser: true });
    h.browser.browser = null; // no browser found for the first run
    const { conversationIds } = await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
    const id = conversationIds[0] ?? '';
    assert.equal(h.record(id).usedBrowserCookies, false);
    h.browser.browser = 'chrome';
    h.processes.last().write(out.error('Sign in to confirm you are not a bot', 'cookies-auth')).exit(1);
    await h.settle();
    assert.deepEqual(h.record(id).retry, { browserCookieMode: 'force', skipTried: false, forceTried: true });
    assert.equal(h.engines.adapters['yt-dlp'].contexts.at(-1)?.browserCookies, 'chrome');
    h.processes.last().write(out.file('/dl/yt-dlp/v.mp4')).exit(0);
    await h.settle();
    assert.equal(h.record(id).status, 'completed');
  });

  it('never reads browser cookies without the opt-in, whatever the engine printed', async () => {
    const h = new DownloadsHarness();
    const { conversationIds } = await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
    const id = conversationIds[0] ?? '';
    h.processes.last().write(out.error('Sign in to confirm you are not a bot', 'cookies-auth')).exit(1);
    await h.settle();
    assert.equal(h.processes.processes.length, 1, 'no retry');
    assert.equal(h.record(id).status, 'failed');
    assert.deepEqual(h.record(id).retry, { browserCookieMode: null, skipTried: false, forceTried: false });
    assert.equal(h.browser.calls, 0, 'the browser cookie store is never touched');
    assert.ok(h.engines.adapters['yt-dlp'].contexts.every((context) => context.browserCookies === null));
  });

  it('a stored force retry mode cannot enable browser cookies once the opt-in is off', async () => {
    const h = new DownloadsHarness();
    h.persistence.settings.patchCookies({ fromBrowser: true });
    h.browser.browser = null;
    const { conversationIds } = await h.startOk(['https://youtube.com/watch?v=1'], { engine: 'yt-dlp' });
    h.browser.browser = 'chrome';
    const slow = gate();
    h.workspace.gate = slow.promise;
    h.processes.last().write(out.error('Sign in to confirm you are not a bot', 'cookies-auth')).exit(1);
    await h.timers.runNext(); // the retry is decided with the opt-in on; its launch waits on the gate
    await settleMicrotasks();
    assert.equal(h.record(conversationIds[0] ?? '').retry.browserCookieMode, 'force');
    h.persistence.settings.patchCookies({ fromBrowser: false });
    h.workspace.gate = null;
    slow.open();
    await h.whenIdle();
    assert.equal(h.processes.processes.length, 2);
    assert.equal(h.engines.adapters['yt-dlp'].contexts.at(-1)?.browserCookies, null);
    assert.equal(h.browser.calls, 1, 'only the first (opted-in) run looked for a browser');
  });
});
