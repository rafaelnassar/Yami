/** Small async primitives shared by host and main. */

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagate the abort reason as-is, like node:timers/promises
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- same as above
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * FIFO async mutex. Serializes critical sections without blocking unrelated work
 * (unlike a global message chain).
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

/** Collapses concurrent calls into one in-flight promise. */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= task().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Trailing throttle: calls `fn` at most once per `intervalMs`, always delivering the
 * latest arguments. `flush()` delivers pending arguments immediately.
 */
export function throttleLatest<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number
): { (...args: A): void; flush(): void; cancel(): void } {
  let lastRun = 0;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (): void => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    lastRun = Date.now();
    fn(...args);
  };

  const throttled = (...args: A): void => {
    pending = args;
    if (timer) return;
    const wait = Math.max(0, lastRun + intervalMs - Date.now());
    timer = setTimeout(run, wait);
    (timer as { unref?: () => void }).unref?.();
  };
  throttled.flush = (): void => {
    if (timer) clearTimeout(timer);
    run();
  };
  throttled.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return throttled;
}
