import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeRequest } from '../../shared/testing/fake-request.ts';
import { hostState, progress } from '../../shared/testing/fixtures.ts';
import { createManualScheduler } from '../../shared/testing/manual-scheduler.ts';
import { createHostStore, INIT_RETRY_DELAYS_MS, initRetryDelay, isHostReady } from './host-store.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('host store', () => {
  it('coalesces bursts of state events into one update per frame (latest wins)', () => {
    const scheduler = createManualScheduler();
    const store = createHostStore({ request: createFakeRequest({}).request, scheduler, restartHost: async () => null });
    let updates = 0;
    store.subscribe((state, previous) => {
      if (state.state !== previous.state) updates += 1;
    });
    for (let i = 0; i < 10; i += 1)
      store.getState().receiveState(hostState({ active: [progress('a', { percent: i })] }));
    assert.equal(updates, 0);
    scheduler.flushFrames();
    assert.equal(updates, 1);
    assert.equal(store.getState().state?.downloads.active[0]?.percent, 9);
  });

  it('loads the initial snapshot with session.init and drops older buffered events', async () => {
    const scheduler = createManualScheduler();
    const fresh = hostState();
    const fake = createFakeRequest({ 'session.init': () => ({ ok: true, data: { state: fresh } }) });
    const store = createHostStore({ request: fake.request, scheduler, restartHost: async () => null });
    store.getState().receiveState(hostState({ active: [progress('stale')] }));
    await store.getState().init();
    scheduler.flushFrames();
    assert.equal(store.getState().state, fresh);
  });

  it('tracks readiness and restart state', async () => {
    const store = createHostStore({
      request: createFakeRequest({ 'session.init': () => ({ ok: false, error: { code: 'HOST_UNAVAILABLE' } }) })
        .request,
      scheduler: createManualScheduler(),
      restartHost: async () => ({ code: 'HOST_TIMEOUT' })
    });
    assert.equal(isHostReady(store.getState()), false);
    await store.getState().init();
    assert.deepEqual(store.getState().initError, { code: 'HOST_UNAVAILABLE' });
    store.getState().setConnection({ state: 'ready' });
    assert.equal(isHostReady(store.getState()), false);
    assert.deepEqual(await store.getState().restart(), { code: 'HOST_TIMEOUT' });
    assert.equal(store.getState().restarting, false);
  });

  it('retries a failed session.init with backoff until it succeeds', async () => {
    const scheduler = createManualScheduler();
    let attempts = 0;
    const fake = createFakeRequest({
      'session.init': () =>
        ++attempts < 4 ? { ok: false, error: { code: 'HOST_UNAVAILABLE' } } : { ok: true, data: { state: hostState() } }
    });
    const store = createHostStore({ request: fake.request, scheduler, restartHost: async () => null });
    store.getState().setConnection({ state: 'ready' });
    await store.getState().init();
    assert.equal(attempts, 1);
    assert.deepEqual(store.getState().initError, { code: 'HOST_UNAVAILABLE' });
    scheduler.advance(initRetryDelay(1) - 1);
    await flush();
    assert.equal(attempts, 1);
    scheduler.advance(1);
    await flush();
    assert.equal(attempts, 2);
    scheduler.advance(initRetryDelay(2));
    await flush();
    assert.equal(attempts, 3);
    scheduler.advance(initRetryDelay(3));
    await flush();
    assert.equal(attempts, 4);
    assert.equal(store.getState().initError, null);
    assert.equal(isHostReady(store.getState()), true);
    assert.equal(scheduler.pendingCount, 0);
  });

  it('stops retrying while the host is offline and caps the backoff', async () => {
    const scheduler = createManualScheduler();
    let attempts = 0;
    const fake = createFakeRequest({
      'session.init': () => (attempts++, { ok: false, error: { code: 'HOST_UNAVAILABLE' } })
    });
    const store = createHostStore({ request: fake.request, scheduler, restartHost: async () => null });
    await store.getState().init();
    store.getState().setConnection({ state: 'offline', error: null });
    scheduler.advance(60_000);
    await flush();
    assert.equal(attempts, 1);
    assert.equal(initRetryDelay(1), INIT_RETRY_DELAYS_MS[0]);
    assert.equal(initRetryDelay(99), INIT_RETRY_DELAYS_MS.at(-1));
  });

  it('a manual init replaces the scheduled retry (single flight)', async () => {
    const scheduler = createManualScheduler();
    let attempts = 0;
    const fake = createFakeRequest({
      'session.init': () => (attempts++, { ok: false, error: { code: 'HOST_UNAVAILABLE' } })
    });
    const store = createHostStore({ request: fake.request, scheduler, restartHost: async () => null });
    await store.getState().init();
    await store.getState().init();
    assert.equal(attempts, 2);
    assert.equal(scheduler.pendingCount, 1);
  });
});
