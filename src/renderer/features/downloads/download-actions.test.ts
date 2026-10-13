import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMediaUrlCache } from '../../shared/lib/media-cache.ts';
import { createFakeRequest, type FakeHandlers } from '../../shared/testing/fake-request.ts';
import { mediaFile, summary } from '../../shared/testing/fixtures.ts';
import { createManualScheduler } from '../../shared/testing/manual-scheduler.ts';
import { createNoticesStore } from '../notices/notices-store.ts';
import { createPreviewStore } from '../preview/preview-store.ts';
import { createDownloadActions } from './download-actions.ts';
import { createActiveConversationStore } from './store/active-conversation-store.ts';
import { createComposerStore } from './store/composer-store.ts';
import { createConversationsStore } from './store/conversations-store.ts';
import { createFoldersStore } from './store/folders-store.ts';

function setup(handlers: FakeHandlers) {
  const scheduler = createManualScheduler();
  const fake = createFakeRequest({
    'conversations.list': () => ({ ok: true, data: { items: [], nextCursor: null } }),
    'conversations.get': (payload) => ({
      ok: false,
      error: { code: 'CONVERSATION_NOT_FOUND', params: { id: payload.conversationId } }
    }),
    'conversations.files': () => ({ ok: true, data: { items: [], nextCursor: null } }),
    ...handlers
  });
  const deps = {
    request: fake.request,
    notices: createNoticesStore({ now: scheduler.now }),
    conversations: createConversationsStore({ request: fake.request, scheduler }),
    active: createActiveConversationStore({ request: fake.request, scheduler }),
    composer: createComposerStore(),
    folders: createFoldersStore({ request: fake.request }),
    preview: createPreviewStore(),
    media: createMediaUrlCache({
      fetcher: async () => ({ ok: false, error: { code: 'NOT_SUPPORTED' } }),
      now: scheduler.now
    })
  };
  return { fake, deps, actions: createDownloadActions(deps) };
}

describe('download actions', () => {
  it('starts into the pending folder, opens the first conversation and clears the draft', async () => {
    const { fake, deps, actions } = setup({
      'downloads.start': () => ({ ok: true, data: { batchId: 'b1', conversationIds: ['c1', 'c2'] } })
    });
    deps.composer.getState().setUrlDraft('https://example.com/x');
    deps.composer.getState().setPendingFolder('f1');
    assert.equal(await actions.start(['https://example.com/x'], 'yt-dlp', 'single'), true);
    assert.deepEqual(fake.calls[0], {
      command: 'downloads.start',
      payload: { urls: ['https://example.com/x'], engine: 'yt-dlp', scope: 'single', folderId: 'f1' }
    });
    assert.equal(deps.active.getState().id, 'c1');
    assert.equal(deps.composer.getState().urlDraft, '');
    assert.equal(deps.composer.getState().pendingFolderId, null);
    assert.equal(deps.composer.getState().starting, 0);
    assert.equal(deps.notices.getState().toasts[0]?.kind, 'info');
  });

  it('keeps the draft and shows the error when start fails', async () => {
    const { deps, actions } = setup({
      'downloads.start': () => ({ ok: false, error: { code: 'ENGINE_UNAVAILABLE', params: { engine: 'yt-dlp' } } })
    });
    deps.composer.getState().setUrlDraft('https://example.com/x');
    assert.equal(await actions.start(['https://example.com/x'], 'yt-dlp', 'single'), false);
    assert.equal(deps.composer.getState().urlDraft, 'https://example.com/x');
    const toast = deps.notices.getState().toasts[0];
    assert.equal(toast?.kind, 'error');
    assert.deepEqual(toast?.message, {
      kind: 'error',
      error: { code: 'ENGINE_UNAVAILABLE', params: { engine: 'yt-dlp' } }
    });
  });

  it('deletes many files with ONE request and forgets them everywhere', async () => {
    const paths = ['/dl/a.jpg', '/dl/b.jpg', '/dl/c.jpg'];
    const { fake, deps, actions } = setup({
      'files.delete': (payload) => ({
        ok: true,
        data: {
          deleted: payload.paths.slice(0, 2),
          failed: [{ path: '/dl/c.jpg', error: { code: 'FILE_OPERATION_FAILED' } }]
        }
      })
    });
    deps.preview.getState().open({ path: '/dl/a.jpg', name: 'a.jpg', mediaType: 'image', sizeBytes: 1, ts: 1 });
    assert.equal(await actions.deleteFiles(paths), false);
    assert.equal(fake.calls.filter((call) => call.command === 'files.delete').length, 1);
    assert.equal(deps.preview.getState().current, null);
    const toast = deps.notices.getState().toasts[0];
    assert.equal(toast?.kind, 'warn');
    assert.deepEqual(toast?.message, {
      kind: 'key',
      key: 'ui.session.toast.deletePartialMsg',
      params: { removed: 2, failed: 1 }
    });
  });

  it('deletes a conversation (optionally with files) and returns home', async () => {
    const { fake, deps, actions } = setup({
      'conversations.delete': () => ({
        ok: true,
        data: { conversationId: 'c1', filesDeleted: 3, filesFailed: 0, filesKept: 0 }
      }),
      'conversations.get': () => ({
        ok: true,
        data: { conversation: { ...summary('c1'), events: [], filesCount: 1 } }
      }),
      'conversations.files': () => ({ ok: true, data: { items: [mediaFile(1, '/dl/a.jpg')], nextCursor: null } })
    });
    deps.active.getState().open('c1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await actions.deleteConversation('c1', true), true);
    assert.deepEqual(fake.calls.find((call) => call.command === 'conversations.delete')?.payload, {
      conversationId: 'c1',
      deleteFiles: true
    });
    assert.equal(deps.active.getState().id, null);
    assert.deepEqual(deps.notices.getState().toasts[0]?.message, {
      kind: 'key',
      key: 'ui.session.toast.conversationDeletedWithFiles',
      params: { count: 3 }
    });
  });

  it('moves conversations optimistically and rolls back on failure', async () => {
    const { deps, actions } = setup({
      'conversations.list': () => ({ ok: true, data: { items: [summary('a', { folderId: 'f0' })], nextCursor: null } }),
      'conversations.moveToFolder': () => ({ ok: false, error: { code: 'FOLDER_NOT_FOUND' } })
    });
    await deps.conversations.getState().refresh();
    assert.equal(await actions.moveToFolder(['a'], 'f9'), false);
    assert.equal(deps.conversations.getState().items[0]?.folderId, 'f0');
  });

  it('restarts only restartable conversations of a folder and summarizes', async () => {
    const { fake, deps, actions } = setup({ 'downloads.restart': () => ({ ok: true, data: { conversationId: 'x' } }) });
    await actions.restartMany([
      summary('a', { status: 'failed' }),
      summary('b', { status: 'running' }),
      summary('c', { status: 'completed' })
    ]);
    assert.equal(fake.calls.filter((call) => call.command === 'downloads.restart').length, 2);
    assert.deepEqual(deps.notices.getState().toasts[0]?.title, {
      kind: 'key',
      key: 'ui.session.toast.restartedMany',
      params: { count: 2 }
    });
  });
});
