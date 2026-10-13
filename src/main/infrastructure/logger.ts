/** Structured logger used by every main-process module (implemented by `FileLogger`). */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMeta = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Child logger that prefixes every message with `[scope]`. */
  child(scope: string): Logger;
}

/** Logger that drops everything (tests and early bootstrap). */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger
};

/** Serializes an unknown thrown value for log metadata (never throws). */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
