/**
 * Coalesces identity reads issued within a few milliseconds into ONE OS query.
 *
 * Shutdown stops many engines in parallel and every stop needs a strict identity
 * read; on Windows each read is a PowerShell spawn (hundreds of ms). Requests are
 * collected for `windowMs` and then sent as a single `readMany`. A request never
 * joins a query that is already running, so every result comes from a query that
 * started AFTER the request was made (strict reads stay fresh).
 */
import { type ProcessIdentityReader, type ProcessLookup, isValidPid } from './process-snapshot.ts';

/** Default collection window: long enough for a `Promise.all` fan-out, far below a PowerShell spawn. */
export const DEFAULT_BATCH_WINDOW_MS = 5;

interface Waiter {
  readonly pids: readonly number[];
  readonly resolve: (lookups: ReadonlyMap<number, ProcessLookup>) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingBatch {
  readonly pids: Set<number>;
  readonly waiters: Waiter[];
}

export class BatchedIdentityReader implements ProcessIdentityReader {
  readonly #inner: ProcessIdentityReader;
  readonly #windowMs: number;
  #pending: PendingBatch | null = null;

  constructor(inner: ProcessIdentityReader, windowMs: number = DEFAULT_BATCH_WINDOW_MS) {
    this.#inner = inner;
    this.#windowMs = Math.max(0, windowMs);
  }

  async read(pid: number): Promise<ProcessLookup> {
    if (!isValidPid(pid)) return null;
    return (await this.readMany([pid])).get(pid) ?? null;
  }

  readMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessLookup>> {
    const valid = pids.filter(isValidPid);
    if (valid.length === 0) return Promise.resolve(new Map(pids.map((pid) => [pid, null] as const)));
    return new Promise((resolve, reject) => {
      const batch = this.#pending ?? this.#open();
      for (const pid of valid) batch.pids.add(pid);
      batch.waiters.push({ pids, resolve, reject });
    });
  }

  #open(): PendingBatch {
    const batch: PendingBatch = { pids: new Set(), waiters: [] };
    this.#pending = batch;
    setTimeout(() => void this.#flush(batch), this.#windowMs);
    return batch;
  }

  async #flush(batch: PendingBatch): Promise<void> {
    // Later requests start a new batch: they must not join a query already in flight.
    if (this.#pending === batch) this.#pending = null;
    let lookups: ReadonlyMap<number, ProcessLookup>;
    try {
      lookups = await this.#inner.readMany([...batch.pids]);
    } catch (error) {
      for (const waiter of batch.waiters) waiter.reject(error);
      return;
    }
    for (const waiter of batch.waiters) {
      waiter.resolve(new Map(waiter.pids.map((pid) => [pid, lookups.get(pid) ?? null] as const)));
    }
  }
}
