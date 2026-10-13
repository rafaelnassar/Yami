import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Mutex, delay, singleFlight, throttleLatest } from './async.ts';

describe('shared/kernel/async', () => {
  it('delay resolves after the interval and rejects when already aborted', async () => {
    const started = Date.now();
    await delay(15);
    assert.ok(Date.now() - started >= 10);
    const signal = AbortSignal.abort('stop');
    await assert.rejects(
      () => delay(50, signal),
      (reason) => reason === 'stop'
    );
  });

  it('delay rejects when aborted while waiting', async () => {
    const controller = new AbortController();
    const pending = delay(5_000, controller.signal);
    controller.abort('later');
    await assert.rejects(
      () => pending,
      (reason) => reason === 'later'
    );
  });

  it('Mutex serializes exclusive tasks', async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    await Promise.all([
      mutex.runExclusive(async () => {
        order.push(1);
        await delay(20);
        order.push(2);
      }),
      mutex.runExclusive(() => {
        order.push(3);
      })
    ]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('singleFlight shares one in-flight promise', async () => {
    let runs = 0;
    const flight = singleFlight(async () => {
      runs += 1;
      await delay(20);
      return runs;
    });
    const [a, b] = await Promise.all([flight(), flight()]);
    assert.equal(a, 1);
    assert.equal(b, 1);
    assert.equal(await flight(), 2);
  });

  it('throttleLatest delivers the latest args and supports flush/cancel', async () => {
    const seen: string[] = [];
    const throttled = throttleLatest((value: string) => {
      seen.push(value);
    }, 30);
    throttled('a');
    throttled('b');
    await delay(50);
    assert.deepEqual(seen, ['b']);
    throttled('c');
    throttled.flush();
    assert.deepEqual(seen, ['b', 'c']);
    throttled('d');
    throttled.cancel();
    await delay(50);
    assert.deepEqual(seen, ['b', 'c']);
  });
});
