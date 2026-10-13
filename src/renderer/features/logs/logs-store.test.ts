import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogEntryDto } from '../../../shared/contracts/dto.ts';
import { createFakeRequest } from '../../shared/testing/fake-request.ts';
import { appendRing, createLogsStore, MAX_LOG_ENTRIES } from './logs-store.ts';

const entry = (ts: number): LogEntryDto => ({
  ts,
  level: 'info',
  text: `line ${ts}`,
  code: null,
  params: {},
  conversationId: null
});

describe('logs store', () => {
  it('keeps a ring of the newest entries', () => {
    assert.deepEqual(appendRing([1, 2, 3], [4, 5], 4), [2, 3, 4, 5]);
    assert.deepEqual(appendRing([1], [2, 3, 4, 5, 6], 3), [4, 5, 6]);
    const same = [1];
    assert.equal(appendRing(same, [], 3), same);
  });

  it('caps live entries at MAX_LOG_ENTRIES', () => {
    const store = createLogsStore({ request: createFakeRequest({}).request });
    store.getState().append(Array.from({ length: MAX_LOG_ENTRIES + 20 }, (_, i) => entry(i)));
    assert.equal(store.getState().entries.length, MAX_LOG_ENTRIES);
    assert.equal(store.getState().entries[0]?.ts, 20);
  });

  it('replaces the buffer with the host history, keeping newer live entries', async () => {
    const fake = createFakeRequest({ 'logs.recent': () => ({ ok: true, data: { entries: [entry(1), entry(2)] } }) });
    const store = createLogsStore({ request: fake.request });
    store.getState().append([entry(0), entry(3)]);
    await store.getState().loadRecent();
    assert.deepEqual(
      store.getState().entries.map((item) => item.ts),
      [1, 2, 3]
    );
    store.getState().clear();
    assert.equal(store.getState().entries.length, 0);
  });
});
