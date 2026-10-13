/** No-op `Logger` used when the composition root does not inject one (tests, tools). */
import type { Logger } from '../../application/ports/system.ts';

export function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger
  };
  return logger;
}

/** Short, non-sensitive description of a thrown value for structured logs. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}
