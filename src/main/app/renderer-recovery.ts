/**
 * Decides whether a crashed renderer is reloaded: at most 3 reloads per window per
 * minute, with growing delays, so a renderer that crashes on load cannot spin forever.
 */

export type RecoveryDecision = { readonly reload: true; readonly delayMs: number } | { readonly reload: false };

const DELAYS_MS = [500, 2_000, 5_000] as const;

export class RendererRecovery {
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #max: number;
  readonly #history = new Map<string, number[]>();

  constructor(now: () => number, options: { windowMs?: number; max?: number } = {}) {
    this.#now = now;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#max = options.max ?? 3;
  }

  /** `reason` is Electron's `RenderProcessGoneDetails.reason`. */
  onGone(windowKey: string, reason: string): RecoveryDecision {
    // A clean exit is not a crash (e.g. the window is being destroyed).
    if (reason === 'clean-exit') return { reload: false };
    const now = this.#now();
    const recent = (this.#history.get(windowKey) ?? []).filter((at) => now - at < this.#windowMs);
    if (recent.length >= this.#max) {
      this.#history.set(windowKey, recent);
      return { reload: false };
    }
    recent.push(now);
    this.#history.set(windowKey, recent);
    return { reload: true, delayMs: DELAYS_MS[Math.min(recent.length - 1, DELAYS_MS.length - 1)] ?? 5_000 };
  }
}
