import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeRequest } from '../../../shared/testing/fake-request.ts';
import { summary } from '../../../shared/testing/fixtures.ts';
import { createManualScheduler } from '../../../shared/testing/manual-scheduler.ts';
import {
  createConversationsStore,
  DELETED_MEMORY_MS,
  mergeSummaries,
  REFRESH_DEBOUNCE_MS
} from './conversations-store.ts';

describe('mergeSummaries', () => {
  it('puts new rows on top and keeps existing rows (and identity) in place', () => {
    const a = summary('a');
    const b = summary('b');
    const merged = mergeSummaries([a, b], [summary('c'), summary('b'), summary('a', { title: 'renamed' })]);
    assert.deepEqual(
      merged.map((item) => item.id),
      ['c', 'a', 'b']
    );
    assert.equal(merged[2], b);
    assert.equal(merged[1]?.title, 'renamed');
  });

  it('returns the previous array when nothing changed and drops missing rows', () => {
    const previous = [summary('a'), summary('b')];
    assert.equal(mergeSummaries(previous, [summary('a'), summary('b')]), previous);
    assert.deepEqual(
      mergeSummaries(previous, [summary('b')]).map((item) => item.id),
      ['b']
    );
    assert.deepEqual(
      mergeSummaries(previous, [summary('b')], true).map((item) => item.id),
      ['a', 'b']
    );
  });
});

describe('conversations store', () => {
  it('debounces refreshes and only refreshes once loaded', async () => {
    const scheduler = createManualScheduler();
    const fake = createFakeRequest({
      'conversations.list': () => ({ ok: true, data: { items: [summary('a')], nextCursor: 'next' } })
    });
    const store = createConversationsStore({ request: fake.request, scheduler });
    store.getState().scheduleRefresh();
    scheduler.advance(REFRESH_DEBOUNCE_MS);
    assert.equal(fake.calls.length, 0);
    await store.getState().refresh();
    assert.equal(store.getState().loaded, true);
    assert.equal(store.getState().nextCursor, 'next');
    for (let i = 0; i < 5; i += 1) store.getState().scheduleRefresh();
    scheduler.advance(REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    assert.equal(fake.calls.length, 2);
  });

  it('appends further pages without duplicates', async () => {
    const fake = createFakeRequest({
      'conversations.list': (payload) =>
        payload.cursor
          ? { ok: true, data: { items: [summary('b'), summary('c')], nextCursor: null } }
          : { ok: true, data: { items: [summary('a'), summary('b')], nextCursor: 'p2' } }
    });
    const store = createConversationsStore({ request: fake.request, scheduler: createManualScheduler() });
    await store.getState().refresh();
    await store.getState().loadMore();
    assert.deepEqual(
      store.getState().items.map((item) => item.id),
      ['a', 'b', 'c']
    );
    assert.equal(store.getState().nextCursor, null);
  });

  it('patches and removes rows locally', async () => {
    const fake = createFakeRequest({
      'conversations.list': () => ({ ok: true, data: { items: [summary('a'), summary('b')], nextCursor: null } })
    });
    const store = createConversationsStore({ request: fake.request, scheduler: createManualScheduler() });
    await store.getState().refresh();
    store.getState().patch(['a'], { folderId: 'f1' });
    store.getState().remove('b');
    assert.deepEqual(
      store.getState().items.map((item) => [item.id, item.folderId]),
      [['a', 'f1']]
    );
  });

  it('keeps the error of a failed refresh', async () => {
    const fake = createFakeRequest({
      'conversations.list': () => ({ ok: false, error: { code: 'HOST_UNAVAILABLE' } })
    });
    const store = createConversationsStore({ request: fake.request, scheduler: createManualScheduler() });
    await store.getState().refresh();
    assert.deepEqual(store.getState().error, { code: 'HOST_UNAVAILABLE' });
    assert.equal(store.getState().loading, false);
  });

  it('does not resurrect a conversation deleted while a refresh was in flight', async () => {
    const scheduler = createManualScheduler();
    let release!: () => void;
    let gated = false;
    const fake = createFakeRequest({
      'conversations.list': async () => {
        if (gated) await new Promise<void>((resolve) => (release = resolve));
        return { ok: true, data: { items: [summary('a'), summary('b')], nextCursor: null } };
      }
    });
    const store = createConversationsStore({ request: fake.request, scheduler });
    await store.getState().refresh();
    gated = true;
    const refreshing = store.getState().refresh();
    await Promise.resolve();
    store.getState().remove('b');
    release();
    await refreshing;
    assert.deepEqual(
      store.getState().items.map((item) => item.id),
      ['a']
    );
    gated = false;
    scheduler.advance(DELETED_MEMORY_MS + 1);
    await store.getState().refresh();
    assert.deepEqual(
      store
        .getState()
        .items.map((item) => item.id)
        .sort(),
      ['a', 'b'],
      'the memory expires'
    );
  });
});
