/** In-flight host requests keyed by envelope id, each with its own timeout. */
import { appError, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, type Result } from '../../shared/kernel/result.ts';
import type { Cancel } from '../infrastructure/timers.ts';

type Settle = (result: Result<unknown, AppErrorData>) => void;

export class PendingRequests {
  readonly #entries = new Map<string, { readonly settle: Settle; readonly cancelTimeout: Cancel }>();

  get size(): number {
    return this.#entries.size;
  }

  add(id: string, settle: Settle, cancelTimeout: Cancel): void {
    this.#entries.set(id, { settle, cancelTimeout });
  }

  /** Resolves one request; returns false when it is unknown (late reply after a timeout). */
  settle(id: string, result: Result<unknown, AppErrorData>): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    entry.cancelTimeout();
    entry.settle(result);
    return true;
  }

  /** Forgets a request whose timeout already fired. */
  drop(id: string): void {
    this.#entries.delete(id);
  }

  failAll(code: AppErrorData['code']): void {
    for (const id of [...this.#entries.keys()]) this.settle(id, err(appError(code)));
  }
}
