/**
 * `ProcessInspector`: "is the process of this download still running?".
 *
 * - Strict checks (`isAlive({ strict: true })`, `check`) always read the identity
 *   (image name + start token) from the OS to defeat PID reuse.
 * - Cheap checks (`aliveMany`, non-strict `isAlive`, polled for re-attached runs)
 *   use `kill(pid, 0)` for liveness and compare against an identity snapshot
 *   cached for `cacheTtlMs`; only expired entries are re-read, in one batch.
 * All OS reads go through a `BatchedIdentityReader`, so concurrent checks (e.g.
 * parallel terminations at shutdown) share one query.
 */
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { ProcessInspector } from '../../application/ports/processes.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import { type Clock, systemClock } from '../../../shared/kernel/clock.ts';
import { BatchedIdentityReader, DEFAULT_BATCH_WINDOW_MS } from './batched-identity-reader.ts';
import { identityMatches } from './identity-match.ts';
import { NodeProcessSignals, type ProcessSignals } from './process-signals.ts';
import {
  type ProcessIdentityReader,
  type ProcessLookup,
  type ProcessSnapshot,
  isValidPid,
  uniquePids
} from './process-snapshot.ts';

/** Strict (uncached) verdict: running and ours, gone (dead/zombie), or PID reused by another program. */
export type ProcessCheck = 'alive' | 'gone' | 'mismatch';

/** Richer strict check used by the terminator (a boolean cannot tell "gone" from "someone else's"). */
export interface ProcessIdentityChecker {
  check(identity: ProcessIdentity): Promise<ProcessCheck>;
}

const DEFAULT_CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 256;

export interface NodeProcessInspectorOptions {
  readonly platform: HostPlatform;
  readonly reader: ProcessIdentityReader;
  readonly signals?: ProcessSignals;
  readonly clock?: Clock;
  /** How long a snapshot serves cheap checks before it is re-read (default 10 s). */
  readonly cacheTtlMs?: number;
  /** Window in which OS reads are coalesced into one query (default 5 ms). */
  readonly batchWindowMs?: number;
}

interface CacheEntry {
  readonly snapshot: ProcessSnapshot;
  readonly at: number;
}

export class NodeProcessInspector implements ProcessInspector, ProcessIdentityChecker {
  readonly #platform: HostPlatform;
  readonly #reader: ProcessIdentityReader;
  readonly #signals: ProcessSignals;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #cache = new Map<number, CacheEntry>();

  constructor(options: NodeProcessInspectorOptions) {
    this.#platform = options.platform;
    this.#reader = new BatchedIdentityReader(options.reader, options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS);
    this.#signals = options.signals ?? new NodeProcessSignals();
    this.#clock = options.clock ?? systemClock;
    this.#ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async isAlive(identity: ProcessIdentity, options: { readonly strict: boolean }): Promise<boolean> {
    if (!options.strict) return (await this.aliveMany([identity])).get(identity.pid) ?? false;
    return (await this.check(identity)) === 'alive';
  }

  async check(identity: ProcessIdentity): Promise<ProcessCheck> {
    const { pid } = identity;
    // Strict: EPERM means another user's process, never an engine we launched.
    if (!isValidPid(pid) || this.#signals.probe(pid) !== 'running') {
      this.#cache.delete(pid);
      return 'gone';
    }
    const lookup = await this.#reader.read(pid);
    this.#remember(pid, lookup);
    if (lookup === null) return 'gone';
    return identityMatches(identity, lookup, this.#platform) ? 'alive' : 'mismatch';
  }

  async aliveMany(identities: readonly ProcessIdentity[]): Promise<ReadonlyMap<number, boolean>> {
    const out = new Map<number, boolean>();
    const stale: ProcessIdentity[] = [];
    const now = this.#clock.now();
    for (const identity of identities) {
      const { pid } = identity;
      // ESRCH → gone. EPERM still means "a process exists": the identity comparison decides.
      if (!isValidPid(pid) || this.#signals.probe(pid) === 'missing') {
        this.#cache.delete(pid);
        out.set(pid, false);
        continue;
      }
      const cached = this.#fresh(pid, now);
      if (cached) out.set(pid, identityMatches(identity, cached, this.#platform));
      else stale.push(identity);
    }
    if (stale.length === 0) return out;
    const lookups = await this.#reader.readMany(uniquePids(stale.map((identity) => identity.pid)));
    for (const identity of stale) {
      const lookup = lookups.get(identity.pid) ?? null;
      this.#remember(identity.pid, lookup);
      out.set(identity.pid, lookup !== null && identityMatches(identity, lookup, this.#platform));
    }
    return out;
  }

  #fresh(pid: number, now: number): ProcessSnapshot | null {
    const entry = this.#cache.get(pid);
    if (!entry) return null;
    if (now - entry.at < this.#ttlMs) return entry.snapshot;
    this.#cache.delete(pid);
    return null;
  }

  /**
   * Only live snapshots are cached: a "gone" answer is re-confirmed by the next
   * read instead of being replayed for a whole TTL.
   */
  #remember(pid: number, lookup: ProcessLookup): void {
    this.#cache.delete(pid);
    if (lookup === null) return;
    this.#cache.set(pid, { snapshot: lookup, at: this.#clock.now() });
    while (this.#cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
  }
}
