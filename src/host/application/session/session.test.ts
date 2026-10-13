import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogEntryDto, VaultStatusDto } from '../../../shared/contracts/dto.ts';
import { AccountsStatus, emptySitesRecord } from '../accounts/accounts-status.ts';
import { makeNotice } from '../testing-a2/records.ts';
import { RecordingEventSink } from '../testing-a2/recording-event-sink.ts';
import { createWorld } from '../testing-a2/world.ts';
import { DownloadHistoryService } from './download-history.ts';
import { NoticeCenter } from './notice-center.ts';
import { NoticesService } from './notices-service.ts';
import { RecentLogs } from './recent-logs.ts';
import { SessionService } from './session-service.ts';
import { StateProjector } from './state-projector.ts';
import { StatePublisher } from './state-publisher.ts';

function log(index: number): LogEntryDto {
  return { ts: index, level: 'info', text: `line ${index}`, code: null, params: {}, conversationId: null };
}

describe('NoticeCenter', () => {
  it('forwards every event and remembers the last error notice', () => {
    const inner = new RecordingEventSink();
    const center = new NoticeCenter(inner);
    const warn = makeNotice({ id: 'w', kind: 'warn' });
    const first = makeNotice({ id: 'e1' });
    const second = makeNotice({ id: 'e2' });
    center.publish({ type: 'notice', notice: first });
    center.publish({ type: 'notice', notice: warn });
    center.publish({ type: 'notice', notice: second });
    center.publish({ type: 'folders.changed' });
    assert.equal(inner.events.length, 4);
    assert.deepEqual(center.lastError(), second);
    center.clearError();
    assert.equal(center.lastError(), null);
  });

  it('drops lastError when that notice is dismissed', () => {
    const center = new NoticeCenter(new RecordingEventSink());
    center.publish({ type: 'notice', notice: makeNotice({ id: 'x' }) });
    center.publish({ type: 'notice.dismissed', id: 'other' });
    assert.ok(center.lastError());
    center.publish({ type: 'notice.dismissed', id: 'x' });
    assert.equal(center.lastError(), null);
  });
});

describe('RecentLogs', () => {
  it('forwards events and keeps the newest entries, oldest first', () => {
    const inner = new RecordingEventSink();
    const logs = new RecentLogs(inner, 3);
    logs.publish({ type: 'log', entries: [log(1), log(2)] });
    logs.publish({ type: 'folders.changed' });
    logs.publish({ type: 'log', entries: [log(3), log(4)] });
    assert.equal(inner.events.length, 3);
    const recent = logs.recent();
    assert.ok(recent.ok);
    assert.deepEqual(
      recent.value.entries.map((entry) => entry.ts),
      [2, 3, 4]
    );
  });

  it('caps at 500 entries by default, even for one huge batch', () => {
    const logs = new RecentLogs(new RecordingEventSink());
    logs.publish({ type: 'log', entries: Array.from({ length: 700 }, (_, i) => log(i)) });
    const recent = logs.recent();
    assert.ok(recent.ok);
    assert.equal(recent.value.entries.length, 500);
    assert.equal(recent.value.entries[0]?.ts, 200);
  });
});

function projectorFor(
  world: ReturnType<typeof createWorld>,
  notices: NoticeCenter,
  accounts: AccountsStatus,
  vault: VaultStatusDto = { state: 'ready' }
) {
  return new StateProjector({
    downloads: world.downloads,
    runtime: world.runtime,
    settings: world.settings,
    accounts,
    sandbox: world.sandbox,
    notices,
    vault
  });
}

describe('StateProjector', () => {
  it('assembles the snapshot from every owner', () => {
    const world = createWorld({
      downloadDir: '/home/ana/Yami',
      settings: { defaultEngine: 'yt-dlp' }
    });
    world.settingsRepository.current = {
      ...world.settingsRepository.current,
      cookies: { active: 'x.txt', fromBrowser: true, bindings: [] }
    };
    world.downloads.snapshotValue = {
      status: 'running',
      active: [],
      queued: [
        { conversationId: 'c1', sourceUrl: 'https://a.b/1', engine: 'yt-dlp', scope: 'single', status: 'pending' }
      ],
      batch: null
    };
    const notices = new NoticeCenter(new RecordingEventSink());
    const error = makeNotice();
    notices.publish({ type: 'notice', notice: error });
    const accounts = new AccountsStatus(world.credentials);
    accounts.set(
      new Map([
        [
          'pixiv',
          {
            kind: 'refresh-token',
            refreshToken: 'secret-token',
            userName: 'ana',
            userId: '1',
            savedAt: 1
          }
        ]
      ])
    );

    const state = projectorFor(world, notices, accounts).project();
    assert.deepEqual(state, {
      status: 'running',
      downloads: { active: [], queued: world.downloads.snapshotValue.queued, batch: null },
      engines: world.runtime.engines(),
      config: {
        defaultEngine: 'yt-dlp',
        downloadDir: '/home/ana/Yami',
        cookies: { active: 'x.txt', fromBrowser: true },
        accounts: {
          sites: { ...emptySitesRecord(), pixiv: { connected: true, userName: 'ana' } },
          pixiv: { connected: true, userName: 'ana' }
        },
        vault: { state: 'ready' }
      },
      runtime: world.runtime.status(),
      lastError: error
    });
    assert.ok(!JSON.stringify(state).includes('secret-token'));
  });

  it('reports a disabled vault with its reason', () => {
    const world = createWorld();
    const disabled: VaultStatusDto = { state: 'disabled', reason: 'keystore' };
    const accounts = new AccountsStatus(world.credentials);
    const state = projectorFor(world, new NoticeCenter(world.sink), accounts, disabled).project();
    assert.deepEqual(state.config.vault, { state: 'disabled', reason: 'keystore' });
  });

  it('is published as a state event by StatePublisher', () => {
    const world = createWorld();
    const projector = projectorFor(world, new NoticeCenter(world.sink), new AccountsStatus(world.credentials));
    new StatePublisher(projector, world.sink).stateChanged();
    const [event] = world.sink.ofType('state');
    assert.equal(event?.state.config.downloadDir, '/dl');
  });
});

describe('SessionService', () => {
  it('reads accounts once and returns the snapshot without side effects', async () => {
    const world = createWorld();
    world.credentials.pixiv = { refreshToken: 'tok-1234567890', userName: null, userId: null, savedAt: 1 };
    const accounts = new AccountsStatus(world.credentials);
    const session = new SessionService(projectorFor(world, new NoticeCenter(world.sink), accounts), accounts);
    const first = await session.init();
    await session.init();
    assert.ok(first.ok);
    assert.deepEqual(first.value.state.config.accounts, {
      sites: { ...emptySitesRecord(), pixiv: { connected: true, userName: null } },
      pixiv: { connected: true, userName: null }
    });
    assert.equal(world.credentials.reads, 1);
    assert.equal(world.sink.events.length, 0);
  });
});

describe('NoticesService', () => {
  it('clears lastError and republishes state only when there was one', () => {
    const world = createWorld();
    const center = new NoticeCenter(world.sink);
    const service = new NoticesService(center, world.state);
    assert.deepEqual(service.clearError(), { ok: true, value: {} });
    assert.equal(world.state.calls, 0);
    center.publish({ type: 'notice', notice: makeNotice() });
    service.clearError();
    assert.equal(center.lastError(), null);
    assert.equal(world.state.calls, 1);
  });
});

describe('DownloadHistoryService', () => {
  it('returns the most recent source URLs up to the limit', () => {
    const world = createWorld();
    world.records.recentUrls = ['https://a/1', 'https://a/2', 'https://a/3'];
    const result = new DownloadHistoryService(world.records).history({ limit: 2 });
    assert.deepEqual(result, { ok: true, value: { sourceUrls: ['https://a/1', 'https://a/2'] } });
  });
});
