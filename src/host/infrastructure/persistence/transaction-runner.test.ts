import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { SqlitePersistence } from './sqlite-persistence.ts';
import { batchRecord, downloadRecord, makeTempDir, openTestPersistence } from './test-fixtures.ts';

describe('SqliteTransactionRunner', () => {
  let cleanup: () => void;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    let dir: string;
    ({ dir, cleanup } = makeTempDir());
    persistence = openTestPersistence(dir);
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('commits the outer unit and returns its value', () => {
    const { tx, downloads } = persistence.context;
    const value = tx.transaction(() => {
      downloads.save(downloadRecord({ id: 'a' }));
      return 7;
    });
    assert.equal(value, 7);
    assert.ok(downloads.get('a'));
  });

  it('rolls back everything when the outer unit throws', () => {
    const { tx, downloads } = persistence.context;
    assert.throws(
      () =>
        tx.transaction(() => {
          downloads.save(downloadRecord({ id: 'a' }));
          tx.transaction(() => downloads.save(downloadRecord({ id: 'b' })));
          throw new Error('outer failed');
        }),
      /outer failed/
    );
    assert.equal(downloads.get('a'), null);
    assert.equal(downloads.get('b'), null);
  });

  it('rolls back only the nested unit when the outer catches its error', () => {
    const { tx, downloads } = persistence.context;
    tx.transaction(() => {
      downloads.save(downloadRecord({ id: 'outer' }));
      assert.throws(() =>
        tx.transaction(() => {
          downloads.save(downloadRecord({ id: 'inner' }));
          tx.transaction(() => downloads.save(downloadRecord({ id: 'deepest' })));
          throw new Error('inner failed');
        })
      );
      tx.transaction(() => downloads.save(downloadRecord({ id: 'sibling' })));
    });
    assert.ok(downloads.get('outer'));
    assert.ok(downloads.get('sibling'));
    assert.equal(downloads.get('inner'), null);
    assert.equal(downloads.get('deepest'), null);
  });

  it('allows saving a download before its batch inside one unit (deferred foreign keys)', () => {
    const { tx, downloads, batches } = persistence.context;
    tx.transaction(() => {
      downloads.save(downloadRecord({ id: 'a', batchId: 'b1' }));
      batches.save(batchRecord({ id: 'b1' }));
    });
    assert.equal(downloads.get('a')?.batchId, 'b1');
  });

  it('rolls back when a deferred foreign key is still violated at commit', () => {
    const { tx, downloads } = persistence.context;
    assert.throws(() => tx.transaction(() => downloads.save(downloadRecord({ id: 'a', batchId: 'missing' }))));
    assert.equal(downloads.get('a'), null);
    // The connection is usable afterwards.
    tx.transaction(() => downloads.save(downloadRecord({ id: 'b' })));
    assert.ok(downloads.get('b'));
  });

  it('rejects asynchronous work and rolls it back', () => {
    const { tx, downloads } = persistence.context;
    assert.throws(
      () =>
        tx.transaction(() => {
          downloads.save(downloadRecord({ id: 'a' }));
          return Promise.resolve(1);
        }),
      /synchronous/
    );
    assert.equal(downloads.get('a'), null);
  });
});
