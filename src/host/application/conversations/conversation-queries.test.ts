import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { makeConversationDetail, makeDownloadRecord } from '../testing-a2/records.ts';
import { createWorld } from '../testing-a2/world.ts';
import { ConversationQueryService, DEFAULT_CONVERSATION_PAGE_SIZE } from './conversation-query-service.ts';
import { MoveToFolderService } from './move-to-folder.ts';
import { RenameConversationService, normalizeTitle } from './rename-conversation.ts';

describe('ConversationQueryService', () => {
  it('lists with defaults and passes the cursor through', () => {
    const world = createWorld();
    const service = new ConversationQueryService(world.queries, world.files);
    service.list({});
    service.list({ limit: 10, cursor: 'abc' });
    assert.deepEqual(world.queries.listCalls, [
      { limit: DEFAULT_CONVERSATION_PAGE_SIZE, cursor: null },
      { limit: 10, cursor: 'abc' }
    ]);
  });

  it('maps a missing conversation to CONVERSATION_NOT_FOUND', () => {
    const world = createWorld();
    const service = new ConversationQueryService(world.queries, world.files);
    const missing = service.get({ conversationId: 'nope' });
    assert.ok(!missing.ok && missing.error.code === ErrorCode.CONVERSATION_NOT_FOUND);
    world.queries.details.set('c1', makeConversationDetail('c1'));
    const found = service.get({ conversationId: 'c1' });
    assert.ok(found.ok && found.value.conversation.id === 'c1');
  });

  it('pages the files of a conversation', () => {
    const world = createWorld();
    for (let i = 0; i < 3; i += 1) {
      const path = `/dl/${i}.jpg`;
      world.files.add({
        conversationId: 'c1',
        path,
        name: `${i}.jpg`,
        mediaType: 'image',
        extension: '.jpg',
        sizeBytes: 1,
        createdAt: i
      });
    }
    const service = new ConversationQueryService(world.queries, world.files);
    const page = service.files({ conversationId: 'c1', limit: 2 });
    assert.ok(page.ok);
    assert.equal(page.value.items.length, 2);
    assert.equal(page.value.nextCursor, '2');
  });
});

describe('RenameConversationService', () => {
  function setup() {
    const world = createWorld({ records: [makeDownloadRecord({ id: 'c1', title: 'old', status: 'running' })] });
    return { world, service: new RenameConversationService(world.records, world.sink, world.clock) };
  }

  it('normalizes the title, saves and publishes conversation.changed', () => {
    const { world, service } = setup();
    const result = service.rename({ conversationId: 'c1', title: '  My   favourite\tartist ' });
    assert.deepEqual(result, { ok: true, value: { conversationId: 'c1', title: 'My favourite artist' } });
    const saved = world.records.get('c1');
    assert.equal(saved?.title, 'My favourite artist');
    assert.equal(saved?.updatedAt, world.clock.now());
    assert.equal(saved?.status, 'running');
    assert.deepEqual(world.sink.events, [{ type: 'conversation.changed', conversationId: 'c1', reason: 'updated' }]);
  });

  it('rejects blank titles and unknown conversations', () => {
    const { world, service } = setup();
    const blank = service.rename({ conversationId: 'c1', title: '   ' });
    assert.ok(!blank.ok && blank.error.code === ErrorCode.TITLE_REQUIRED);
    const missing = service.rename({ conversationId: 'zz', title: 'x' });
    assert.ok(!missing.ok && missing.error.code === ErrorCode.CONVERSATION_NOT_FOUND);
    assert.equal(world.records.saved.length, 0);
  });

  it('skips the write when the title is unchanged and caps at 120 chars', () => {
    const { world, service } = setup();
    service.rename({ conversationId: 'c1', title: 'old' });
    assert.equal(world.records.saved.length, 0);
    assert.equal(world.sink.events.length, 0);
    assert.equal(normalizeTitle('a'.repeat(130))?.length, 120);
  });
});

describe('MoveToFolderService', () => {
  function setup() {
    const world = createWorld({
      records: [makeDownloadRecord({ id: 'c1' }), makeDownloadRecord({ id: 'c2' })],
      folders: [{ id: 'f1', name: 'A', color: '#FFFFFF', collapsed: false, position: 0, createdAt: 1 }]
    });
    return { world, service: new MoveToFolderService(world.folders, world.sink) };
  }

  it('assigns conversations (deduplicated) and publishes folders.changed', () => {
    const { world, service } = setup();
    const result = service.moveToFolder({ conversationIds: ['c1', 'c2', 'c1', 'ghost'], folderId: 'f1' });
    assert.deepEqual(result, { ok: true, value: { moved: 2 } });
    assert.equal(world.records.get('c1')?.folderId, 'f1');
    assert.deepEqual(world.sink.types(), ['folders.changed']);
  });

  it('unassigns with null and rejects unknown folders', () => {
    const { world, service } = setup();
    service.moveToFolder({ conversationIds: ['c1'], folderId: 'f1' });
    service.moveToFolder({ conversationIds: ['c1'], folderId: null });
    assert.equal(world.records.get('c1')?.folderId, null);
    const missing = service.moveToFolder({ conversationIds: ['c1'], folderId: 'nope' });
    assert.ok(!missing.ok && missing.error.code === ErrorCode.FOLDER_NOT_FOUND);
  });
});
