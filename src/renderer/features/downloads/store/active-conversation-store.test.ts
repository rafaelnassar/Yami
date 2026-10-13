import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeRequest } from '../../../shared/testing/fake-request.ts';
import { detail, mediaFile } from '../../../shared/testing/fixtures.ts';
import { createManualScheduler } from '../../../shared/testing/manual-scheduler.ts';
import { createActiveConversationStore, mergeFiles, RELOAD_DEBOUNCE_MS } from './active-conversation-store.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('active conversation store', () => {
  it('loads the detail and first page of files on open', async () => {
    const fake = createFakeRequest({
      'conversations.get': (payload) => ({ ok: true, data: { conversation: detail(payload.conversationId) } }),
      'conversations.files': () => ({ ok: true, data: { items: [mediaFile(1, '/dl/a.jpg')], nextCursor: 'p2' } })
    });
    const store = createActiveConversationStore({ request: fake.request, scheduler: createManualScheduler() });
    store.getState().open('c1');
    await flush();
    assert.equal(store.getState().conversation?.id, 'c1');
    assert.equal(store.getState().files.length, 1);
    assert.equal(store.getState().filesCursor, 'p2');
  });

  it('appends only files of the open conversation, without duplicates', async () => {
    const fake = createFakeRequest({
      'conversations.get': () => ({ ok: true, data: { conversation: detail('c1') } }),
      'conversations.files': () => ({ ok: true, data: { items: [], nextCursor: null } })
    });
    const store = createActiveConversationStore({ request: fake.request, scheduler: createManualScheduler() });
    store.getState().open('c1');
    await flush();
    store
      .getState()
      .appendFiles([mediaFile(1, '/dl/a.jpg'), mediaFile(2, '/dl/b.jpg', 'other'), mediaFile(3, '/dl/a.jpg')]);
    assert.deepEqual(
      store.getState().files.map((file) => file.path),
      ['/dl/a.jpg']
    );
    store.getState().removeFiles(['/dl/a.jpg']);
    assert.equal(store.getState().files.length, 0);
  });

  it('ignores responses of a conversation that is no longer open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeRequest({
      'conversations.get': async (payload) => {
        if (payload.conversationId === 'slow') await gate;
        return { ok: true, data: { conversation: detail(payload.conversationId) } };
      },
      'conversations.files': () => ({ ok: true, data: { items: [], nextCursor: null } })
    });
    const store = createActiveConversationStore({ request: fake.request, scheduler: createManualScheduler() });
    store.getState().open('slow');
    store.getState().open('fast');
    await flush();
    release();
    await flush();
    assert.equal(store.getState().conversation?.id, 'fast');
  });

  it('reports missing conversations and debounces reloads', async () => {
    const missing: string[] = [];
    const scheduler = createManualScheduler();
    const fake = createFakeRequest({
      'conversations.get': () => ({ ok: false, error: { code: 'CONVERSATION_NOT_FOUND' } }),
      'conversations.files': () => ({ ok: true, data: { items: [], nextCursor: null } })
    });
    const store = createActiveConversationStore({
      request: fake.request,
      scheduler,
      onMissing: (id) => missing.push(id)
    });
    store.getState().open('gone');
    await flush();
    assert.deepEqual(missing, ['gone']);
    const before = fake.calls.length;
    store.getState().scheduleReload();
    store.getState().scheduleReload();
    scheduler.advance(RELOAD_DEBOUNCE_MS);
    await flush();
    assert.equal(fake.calls.filter((call) => call.command === 'conversations.get').length, 2);
    assert.equal(fake.calls.length, before + 1);
  });

  it('mergeFiles keeps order and identity when nothing is new', () => {
    const current = [mediaFile(1, '/a.jpg')];
    assert.equal(mergeFiles(current, [mediaFile(9, '/a.jpg')]), current);
    assert.deepEqual(
      mergeFiles(current, [mediaFile(2, '/b.jpg')]).map((file) => file.path),
      ['/a.jpg', '/b.jpg']
    );
  });

  it('a debounced detail reload does not discard the in-flight first page of files', async () => {
    let releaseFiles!: () => void;
    const filesGate = new Promise<void>((resolve) => {
      releaseFiles = resolve;
    });
    let detailCalls = 0;
    const scheduler = createManualScheduler();
    const fake = createFakeRequest({
      'conversations.get': (payload) => {
        detailCalls += 1;
        return { ok: true, data: { conversation: detail(payload.conversationId, { title: `v${detailCalls}` }) } };
      },
      'conversations.files': async () => {
        await filesGate;
        return { ok: true, data: { items: [mediaFile(1, '/dl/a.jpg')], nextCursor: 'p2' } };
      }
    });
    const store = createActiveConversationStore({ request: fake.request, scheduler });
    store.getState().open('c1');
    await flush();
    store.getState().scheduleReload();
    scheduler.advance(RELOAD_DEBOUNCE_MS);
    await flush();
    assert.equal(store.getState().conversation?.title, 'v2');
    releaseFiles();
    await flush();
    assert.deepEqual(
      store.getState().files.map((file) => file.path),
      ['/dl/a.jpg']
    );
    assert.equal(store.getState().filesCursor, 'p2');
    assert.equal(store.getState().loading, false);
  });

  it('a newer detail reload wins over an older one still in flight', async () => {
    const gates: Array<() => void> = [];
    let calls = 0;
    const fake = createFakeRequest({
      'conversations.get': async (payload) => {
        const call = ++calls;
        if (call === 2) await new Promise<void>((resolve) => gates.push(resolve));
        return { ok: true, data: { conversation: detail(payload.conversationId, { title: `v${call}` }) } };
      },
      'conversations.files': () => ({ ok: true, data: { items: [], nextCursor: null } })
    });
    const store = createActiveConversationStore({ request: fake.request, scheduler: createManualScheduler() });
    store.getState().open('c1');
    await flush();
    void store.getState().reload();
    void store.getState().reload();
    await flush();
    assert.equal(store.getState().conversation?.title, 'v3');
    gates.forEach((release) => release());
    await flush();
    assert.equal(store.getState().conversation?.title, 'v3');
  });

  it('reports files page failures separately from the detail and clears them on success', async () => {
    let fail = true;
    const fake = createFakeRequest({
      'conversations.get': () => ({ ok: true, data: { conversation: detail('c1') } }),
      'conversations.files': (payload) =>
        payload.cursor && fail
          ? { ok: false, error: { code: 'HOST_TIMEOUT' } }
          : {
              ok: true,
              data: {
                items: [mediaFile(payload.cursor ? 2 : 1, payload.cursor ? '/dl/b.jpg' : '/dl/a.jpg')],
                nextCursor: payload.cursor ? null : 'p2'
              }
            }
    });
    const store = createActiveConversationStore({ request: fake.request, scheduler: createManualScheduler() });
    store.getState().open('c1');
    await flush();
    await store.getState().loadMoreFiles();
    assert.deepEqual(store.getState().filesError, { code: 'HOST_TIMEOUT' });
    assert.equal(store.getState().error, null);
    assert.equal(store.getState().conversation?.id, 'c1');
    fail = false;
    await store.getState().loadMoreFiles();
    assert.equal(store.getState().filesError, null);
    assert.deepEqual(
      store.getState().files.map((file) => file.path),
      ['/dl/a.jpg', '/dl/b.jpg']
    );
  });
});
