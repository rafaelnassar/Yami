/**
 * `TransactionRunner` over one SQLite connection. The outermost call opens a
 * `BEGIN IMMEDIATE` transaction; nested calls use SAVEPOINTs, so a failing inner
 * unit rolls back only its own writes (the error still propagates — if the outer
 * unit does not catch it, everything is rolled back).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { TransactionRunner } from '../../application/ports/persistence.ts';

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function assertSynchronous(value: unknown): void {
  // node:sqlite is synchronous; an async unit would commit before its awaits run.
  if (isThenable(value)) throw new Error('transaction work must be synchronous');
}

export class SqliteTransactionRunner implements TransactionRunner {
  readonly #db: DatabaseSync;
  #depth = 0;
  #savepoints = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get depth(): number {
    return this.#depth;
  }

  transaction<T>(work: () => T): T {
    return this.#depth === 0 ? this.#outer(work) : this.#nested(work);
  }

  #outer<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    this.#depth = 1;
    try {
      const result = work();
      assertSynchronous(result);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      // COMMIT itself may fail (deferred foreign keys); the transaction is then still open.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#depth = 0;
    }
  }

  #nested<T>(work: () => T): T {
    this.#savepoints += 1;
    const name = `yami_sp_${this.#savepoints}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    this.#depth += 1;
    try {
      const result = work();
      assertSynchronous(result);
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO ${name}`);
      this.#db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }
}
