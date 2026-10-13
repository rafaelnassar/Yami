/** Time source abstraction so domain/application code stays deterministic in tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
