import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DownloadStatus } from '../../../shared/domain/download.ts';
import { Batch, isBatchFinished, type BatchInfo, type BatchMember } from './batch-progress.ts';

function info(id: string, createdAt: number, total = 2, notifiedAt: number | null = null): BatchInfo {
  return { id, engine: 'gallery-dl', total, createdAt, notifiedAt };
}

function member(id: string, status: DownloadStatus, done = 0, skipped = 0, errors = 0): BatchMember {
  return { id, status, counters: { done, skipped, errors } };
}

describe('Batch aggregate', () => {
  it('sums counters and counts finished members', () => {
    const batch = new Batch(info('b1', 1, 3), [member('a', 'completed', 2), member('b', 'running', 1, 1, 1)]);
    assert.deepEqual(batch.progress(), {
      batchId: 'b1',
      engine: 'gallery-dl',
      total: 2,
      finished: 1,
      counters: { done: 3, skipped: 1, errors: 1 }
    });
  });

  it('shows the newest batch that still has an active download', () => {
    const batches = [
      new Batch(info('old', 1), [member('a', 'running')]),
      new Batch(info('newest-done', 9), [member('b', 'completed')]),
      new Batch(info('new', 5), [member('c', 'paused')])
    ];
    assert.equal(Batch.displayed(batches)?.batchId, 'new');
    assert.equal(Batch.displayed([new Batch(info('x', 1), [member('a', 'failed')])]), null);
  });

  it('reports a finished batch once, ignoring deleted members', () => {
    const batch = new Batch(info('b1', 1, 3), [
      member('a', 'completed'),
      member('b', 'failed'),
      member('c', 'cancelled')
    ]);
    assert.deepEqual(batch.finishedSummary(), {
      batchId: 'b1',
      engine: 'gallery-dl',
      total: 3,
      completed: 1,
      failed: 1,
      cancelled: 1
    });
    assert.equal(new Batch(info('b1', 1, 3), batch.members.slice(0, 2)).finishedSummary()?.total, 2);
    assert.equal(new Batch(info('b1', 1, 3, 50), batch.members).finishedSummary(), null);
    assert.equal(new Batch(info('b1', 1, 3), [member('a', 'running')]).finishedSummary(), null);
    assert.equal(new Batch(info('b1', 1, 3), []).finishedSummary(), null);
    assert.equal(isBatchFinished(batch.members), true);
  });

  it('announces only multi-URL batches', () => {
    assert.equal(new Batch(info('b', 1, 1), [member('a', 'completed')]).shouldAnnounce(), false);
    assert.equal(new Batch(info('b', 1, 2), [member('a', 'completed')]).shouldAnnounce(), true);
  });

  it('exposes active/finished predicates', () => {
    const batch = new Batch(info('b1', 1, 2), [member('a', 'completed', 1), member('b', 'running', 2)]);
    assert.equal(batch.hasActiveMember(), true);
    assert.equal(batch.isFinished(), false);
    assert.equal(Batch.displayed([batch])?.batchId, 'b1');
  });
});
