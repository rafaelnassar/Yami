/**
 * Crash-loop protection for the host: exponential backoff (1, 2, 4, 8, 16 s) and at most
 * 5 restarts within a sliding 60 s window; the next crash leaves the host offline until
 * the user restarts it manually. (Legacy respawned on every request, with no backoff.)
 */

export type RestartDecision =
  | { readonly action: 'restart'; readonly attempt: number; readonly delayMs: number }
  | { readonly action: 'give-up'; readonly attempts: number };

export interface RestartPolicyOptions {
  readonly delaysMs?: readonly number[];
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  readonly now: () => number;
}

export const DEFAULT_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

export class RestartPolicy {
  readonly #delays: readonly number[];
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #crashes: number[] = [];

  constructor(options: RestartPolicyOptions) {
    this.#delays = options.delaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now;
  }

  recordCrash(): RestartDecision {
    const now = this.#now();
    this.#crashes = this.#crashes.filter((at) => now - at < this.#windowMs);
    this.#crashes.push(now);
    const attempt = this.#crashes.length;
    if (attempt > this.#maxAttempts) return { action: 'give-up', attempts: attempt - 1 };
    const delayMs = this.#delays[Math.min(attempt - 1, this.#delays.length - 1)] ?? 1_000;
    return { action: 'restart', attempt, delayMs };
  }

  reset(): void {
    this.#crashes = [];
  }
}
