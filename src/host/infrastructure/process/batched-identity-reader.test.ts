import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BatchedIdentityReader } from './batched-identity-reader.ts';
import type { ProcessIdentityReader, ProcessLookup } from './process-snapshot.ts';
import { unknownSnapshot } from './process-snapshot.ts';

/** Records every OS query; each query can be held open to simulate a slow PowerShell. */
class RecordingReader implements ProcessIdentityReader {
  readonly batches: number[][] = [];
  readonly live = new Set<number>();
  hold: Promise<void> | null = null;
  failWith: Error | null = null;

  async read(pid: number): Promise<ProcessLookup> {
    return (await this.readMany([pid])).get(pid) ?? null;
  }

  async readMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessLookup>> {
    this.batches.push([...pids]);
    if (this.hold) await this.hold;
    if (this.failWith) throw this.failWith;
    return new Map(pids.map((pid) => [pid, this.live.has(pid) ? unknownSnapshot(pid) : null] as const));
  }
}

describe('BatchedIdentityReader', () => {
  it('coalesces reads issued in the same window into one query', async () => {
    const inner = new RecordingReader();
    inner.live.add(10).add(11);
    const reader = new BatchedIdentityReader(inner, 5);
    const [a, b, many] = await Promise.all([reader.read(10), reader.read(11), reader.readMany([10, 12])]);
    assert.deepEqual(inner.batches, [[10, 11, 12]]);
    assert.deepEqual(a, unknownSnapshot(10));
    assert.deepEqual(b, unknownSnapshot(11));
    assert.deepEqual(
      [...many.entries()],
      [
        [10, unknownSnapshot(10)],
        [12, null]
      ]
    );
  });

  it('never lets a request join a query that is already running (strict reads stay fresh)', async () => {
    const inner = new RecordingReader();
    inner.live.add(10);
    let release = (): void => undefined;
    inner.hold = new Promise((resolve) => {
      release = resolve;
    });
    const reader = new BatchedIdentityReader(inner, 1);
    const first = reader.read(10);
    while (inner.batches.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = reader.read(10);
    release();
    inner.hold = null;
    await Promise.all([first, second]);
    assert.deepEqual(inner.batches, [[10], [10]]);
  });

  it('answers invalid PIDs with null without querying the OS', async () => {
    const inner = new RecordingReader();
    const reader = new BatchedIdentityReader(inner, 0);
    assert.equal(await reader.read(-5), null);
    assert.deepEqual(
      [...(await reader.readMany([0, -1])).entries()],
      [
        [0, null],
        [-1, null]
      ]
    );
    assert.equal(inner.batches.length, 0);
  });

  it('rejects every waiter of a failed query and recovers for the next batch', async () => {
    const inner = new RecordingReader();
    inner.failWith = new Error('boom');
    const reader = new BatchedIdentityReader(inner, 0);
    const results = await Promise.allSettled([reader.read(1), reader.read(2)]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected']
    );
    inner.failWith = null;
    inner.live.add(3);
    assert.deepEqual(await reader.read(3), unknownSnapshot(3));
    assert.deepEqual(inner.batches, [[1, 2], [3]]);
  });
});
