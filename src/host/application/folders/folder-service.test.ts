import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { makeDownloadRecord, makeFolder } from '../testing-a2/records.ts';
import { sequentialIds } from '../testing-a2/recording-event-sink.ts';
import { createWorld } from '../testing-a2/world.ts';
import { FolderService } from './folder-service.ts';

function setup(options: Parameters<typeof createWorld>[0] = {}) {
  const world = createWorld(options);
  const service = new FolderService({
    folders: world.folders,
    tx: world.tx,
    events: world.sink,
    clock: world.clock,
    newId: sequentialIds('f')
  });
  return { world, service };
}

describe('FolderService', () => {
  it('creates folders at the end with validated fields', () => {
    const { world, service } = setup();
    const first = service.create({ name: ' Artists ', color: '#abcdef' });
    const second = service.create({ name: 'Music', color: '#000000' });
    assert.ok(first.ok && second.ok);
    assert.deepEqual(first.value.folder, {
      id: 'f1',
      name: 'Artists',
      color: '#ABCDEF',
      collapsed: false,
      position: 0,
      createdAt: world.clock.now()
    });
    assert.equal(second.value.folder.position, 1);
    assert.deepEqual(world.sink.types(), ['folders.changed', 'folders.changed']);
  });

  it('rejects invalid names without saving', () => {
    const { world, service } = setup();
    const result = service.create({ name: 'x'.repeat(81), color: '#000000' });
    assert.ok(!result.ok && result.error.code === ErrorCode.FOLDER_NAME_INVALID);
    assert.equal(world.folders.rows.size, 0);
    assert.equal(world.sink.events.length, 0);
  });

  it('lists by position, then creation time', () => {
    const { service } = setup({
      folders: [
        makeFolder({ id: 'b', position: 2 }),
        makeFolder({ id: 'a', position: 1, createdAt: 5 }),
        makeFolder({ id: 'c', position: 1, createdAt: 2 })
      ]
    });
    const result = service.list();
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.folders.map((folder) => folder.id),
      ['c', 'a', 'b']
    );
  });

  it('updates only the given fields', () => {
    const { world, service } = setup({ folders: [makeFolder({ id: 'f1', name: 'Old', color: '#111111' })] });
    const result = service.update({ folderId: 'f1', collapsed: true, name: 'New' });
    assert.ok(result.ok);
    assert.equal(result.value.folder.name, 'New');
    assert.equal(result.value.folder.color, '#111111');
    assert.equal(world.folders.get('f1')?.collapsed, true);
  });

  it('reports unknown folders and invalid patches', () => {
    const { service } = setup({ folders: [makeFolder({ id: 'f1' })] });
    const missing = service.update({ folderId: 'nope', collapsed: true });
    assert.ok(!missing.ok && missing.error.code === ErrorCode.FOLDER_NOT_FOUND);
    const invalid = service.update({ folderId: 'f1', name: '   ' });
    assert.ok(!invalid.ok && invalid.error.code === ErrorCode.FOLDER_NAME_INVALID);
    const deleteMissing = service.delete({ folderId: 'nope' });
    assert.ok(!deleteMissing.ok && deleteMissing.error.code === ErrorCode.FOLDER_NOT_FOUND);
  });

  it('deletes a folder and unassigns (never deletes) its conversations', () => {
    const { world, service } = setup({
      records: [makeDownloadRecord({ id: 'c1', folderId: 'f1' }), makeDownloadRecord({ id: 'c2', folderId: 'f2' })],
      folders: [makeFolder({ id: 'f1' }), makeFolder({ id: 'f2' })]
    });
    assert.deepEqual(service.delete({ folderId: 'f1' }), { ok: true, value: { folderId: 'f1' } });
    assert.equal(world.folders.get('f1'), null);
    assert.equal(world.records.get('c1')?.folderId, null);
    assert.equal(world.records.get('c2')?.folderId, 'f2');
    assert.equal(world.tx.count, 1);
    assert.deepEqual(world.sink.types(), ['folders.changed']);
  });
});
