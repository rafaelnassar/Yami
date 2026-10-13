/**
 * Downloads while the secret vault is disabled (main could not load its key): automatic
 * cookies are skipped; a download whose cookie file was chosen explicitly is paused (not
 * failed) and keeps its partial files. (Without readable credentials the Pixiv token is
 * simply absent: `DisabledCredentialVault.getPixiv` is null.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finishedEventShape } from './conversation-events.ts';
import { out } from './testing/fake-engines.ts';
import { DownloadsHarness } from './testing/harness.ts';

describe('DownloadCoordinator — disabled vault', () => {
  it('runs without the automatic cookie files (site rule, default file)', async () => {
    const h = new DownloadsHarness();
    await h.cookieVault.save('danbooru.txt', 'x');
    await h.cookieVault.save('global.txt', 'x');
    h.persistence.settings.patchCookies({
      active: 'global.txt',
      bindings: [{ id: 'b1', siteHost: 'donmai.us', cookieName: 'danbooru.txt' }]
    });
    h.cookieVault.unavailable = true;
    const { conversationIds } = await h.startOk(['https://danbooru.donmai.us/posts/1', 'https://other.net/y']);
    assert.deepEqual(
      conversationIds.map((id) => h.record(id).status),
      ['running', 'running']
    );
    assert.deepEqual(
      h.engines.adapters['gallery-dl'].contexts.map((context) => context.cookieFile),
      [null, null]
    );
    // The references are kept for when the vault works again.
    assert.equal(h.persistence.settings.load().cookies.active, 'global.txt');
  });

  it('pauses (not fails) a download whose cookie file was chosen explicitly, with a notice', async () => {
    const h = new DownloadsHarness();
    await h.cookieVault.save('chosen.txt', 'x');
    h.cookieVault.unavailable = true;
    const { conversationIds } = await h.startOk(['https://site.com/a'], { cookieNames: ['chosen.txt'] });
    const id = conversationIds[0] ?? '';
    const record = h.record(id);
    assert.equal(record.status, 'paused');
    assert.equal(record.outcome, null);
    assert.equal(h.persistence.events.rows.at(-1)?.code, 'pausedVaultUnavailable');
    assert.equal(h.processes.running().length, 0);
    const notice = h.events.ofType('notice').find((event) => event.notice.code === 'downloadWaitingVault');
    assert.equal(notice?.notice.kind, 'warn');
    assert.equal(notice?.notice.params['cookie'], 'chosen.txt');
    assert.equal(h.events.ofType('download.finished').length, 0);
    assert.deepEqual(h.workspace.cleanups, [], 'nothing of the job is retired');
  });

  it('keeps the partial files of a paused download resumed while the vault is locked, and runs it later', async () => {
    const h = new DownloadsHarness();
    await h.cookieVault.save('chosen.txt', 'x');
    const { conversationIds } = await h.startOk(['https://site.com/a'], { cookieNames: ['chosen.txt'] });
    const id = conversationIds[0] ?? '';
    h.processes.last().write(out.file('/dl/a.jpg'));
    assert.equal((await h.coordinator.pause(id)).ok, true);
    await h.whenIdle();

    h.cookieVault.unavailable = true;
    assert.equal((await h.coordinator.resume(id)).ok, true);
    await h.settle();
    assert.equal(h.record(id).status, 'paused');
    assert.equal(h.record(id).counters.done, 1);
    assert.deepEqual(h.persistence.events.codesOf(id).slice(-2), ['resumed', 'pausedVaultUnavailable']);
    assert.deepEqual(h.workspace.cleanups, [], 'the temp dir with the partial files is kept');

    h.cookieVault.unavailable = false;
    assert.equal((await h.coordinator.resume(id)).ok, true);
    await h.whenIdle();
    assert.equal(h.record(id).status, 'running');
    assert.deepEqual(
      h.cookieVault.materialized.map((entry) => entry.name),
      ['chosen.txt', 'chosen.txt']
    );
  });

  it('maps the reason to its own timeline entry', () => {
    const shape = finishedEventShape(
      { kind: 'error', reason: 'vault-unavailable', detail: 'chosen.txt' },
      { done: 0, skipped: 0, errors: 0 },
      'gallery-dl'
    );
    assert.deepEqual(shape, { type: 'failed', level: 'error', code: 'failedVault', params: { detail: 'chosen.txt' } });
  });
});
