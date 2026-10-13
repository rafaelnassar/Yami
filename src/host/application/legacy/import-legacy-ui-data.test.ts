import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommandPayload } from '../../../shared/contracts/host-protocol.ts';
import { CookiesSnapshotBuilder } from '../cookies/cookies-snapshot.ts';
import { makeDownloadRecord, makeFolder } from '../testing-a2/records.ts';
import { sequentialIds } from '../testing-a2/recording-event-sink.ts';
import { createWorld } from '../testing-a2/world.ts';
import { LegacyUiImportService } from './import-legacy-ui-data.ts';

function setup() {
  const world = createWorld({
    records: [
      makeDownloadRecord({ id: 'c1' }),
      makeDownloadRecord({ id: 'c2' }),
      makeDownloadRecord({ id: 'c3', folderId: 'mine' })
    ],
    folders: [makeFolder({ id: 'mine', name: 'Chosen in the new app', position: 0 })],
    cookies: ['a.txt', 'b.txt'],
    settings: {
      cookies: {
        active: null,
        fromBrowser: false,
        bindings: [{ id: 'keep', siteHost: 'site.com', cookieName: 'a.txt' }]
      }
    }
  });
  const service = new LegacyUiImportService({
    folders: world.folders,
    records: world.records,
    vault: world.cookieVault,
    settings: world.settings,
    tx: world.tx,
    events: world.sink,
    snapshots: new CookiesSnapshotBuilder(world.cookieVault, world.settings, world.sink),
    newBindingId: sequentialIds('cb')
  });
  return { world, service };
}

const payload: CommandPayload<'legacy.importUiData'> = {
  folders: [
    { id: 'f1', name: '  Artists  ', color: '#a78bfa', createdAt: 10, collapsed: true },
    { id: 'f2', name: 'x'.repeat(150), color: 'purple', createdAt: 11, collapsed: false },
    { id: 'mine', name: 'Legacy duplicate id', color: '#000000', createdAt: 12, collapsed: false },
    { id: 'f1', name: 'Duplicate in payload', color: '#000000', createdAt: 13, collapsed: false }
  ],
  folderMap: { c1: 'f1', c2: 'missing-folder', c3: 'f2', ghost: 'f1' },
  cookieBindings: [
    { id: 'b1', siteHost: 'https://www.Pixiv.net/', cookieName: 'b.txt' },
    { id: 'b2', siteHost: 'site.com', cookieName: 'b.txt' },
    { id: 'keep', siteHost: 'other.com', cookieName: 'a.txt' },
    { id: 'b4', siteHost: 'gone.com', cookieName: 'deleted.txt' }
  ]
};

describe('LegacyUiImportService', () => {
  it('imports folders, assignments and bindings that fit the current data', async () => {
    const { world, service } = setup();
    const result = await service.importUiData(payload);
    assert.deepEqual(result, { ok: true, value: { folders: 2, assignments: 1, bindings: 2 } });

    assert.deepEqual(world.folders.get('f1'), {
      id: 'f1',
      name: 'Artists',
      color: '#A78BFA',
      collapsed: true,
      position: 1,
      createdAt: 10
    });
    const f2 = world.folders.get('f2');
    assert.equal(f2?.name.length, 80);
    assert.equal(f2?.color, '#94A3B8');
    assert.equal(world.folders.get('mine')?.name, 'Chosen in the new app');

    assert.equal(world.records.get('c1')?.folderId, 'f1');
    assert.equal(world.records.get('c2')?.folderId, null);
    assert.equal(world.records.get('c3')?.folderId, 'mine');

    assert.deepEqual(world.settingsRepository.current.cookies.bindings, [
      { id: 'keep', siteHost: 'site.com', cookieName: 'a.txt' },
      { id: 'b1', siteHost: 'pixiv.net', cookieName: 'b.txt' },
      { id: 'cb1', siteHost: 'other.com', cookieName: 'a.txt' }
    ]);
    assert.equal(world.tx.count, 1);
    assert.deepEqual(world.sink.types(), ['folders.changed', 'cookies.changed']);
  });

  it('is idempotent: a second run imports nothing and publishes nothing', async () => {
    const { world, service } = setup();
    await service.importUiData(payload);
    const before = structuredClone({
      folders: world.folders.list(),
      bindings: world.settingsRepository.current.cookies.bindings,
      records: [...world.records.rows.values()]
    });
    world.sink.clear();
    const again = await service.importUiData(payload);
    assert.deepEqual(again, { ok: true, value: { folders: 0, assignments: 0, bindings: 0 } });
    const after = {
      folders: world.folders.list(),
      bindings: world.settingsRepository.current.cookies.bindings,
      records: [...world.records.rows.values()]
    };
    assert.deepEqual(after, before);
    assert.equal(world.sink.events.length, 0);
  });
});
