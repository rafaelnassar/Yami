/**
 * `Logger` writing `ISO LEVEL message {json fields}` lines to the rotating
 * `<logsDir>/host.log`. Messages and every string field are redacted with
 * `redactSecrets` (+ the configured private directories) before they are queued.
 */
import type { LogFields, Logger } from '../../application/ports/system.ts';
import { type Clock, systemClock } from '../../../shared/kernel/clock.ts';
import { redactSecrets } from '../../../shared/domain/redaction.ts';
import { FileLogSink, type FileLogSinkOptions } from './file-log-sink.ts';
import { formatFields } from './log-fields.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface FileLoggerOptions extends FileLogSinkOptions {
  /** Least severe level written (default `info`). */
  readonly minLevel?: LogLevel;
  /** Private directories (vault, job workspaces…) whose paths never reach the log. */
  readonly sensitiveDirs?: readonly string[];
  /** Also write each line to stderr (development). */
  readonly mirrorToStderr?: boolean;
  readonly clock?: Clock;
}

export interface FileLoggerSettings {
  readonly minLevel?: LogLevel;
  readonly sensitiveDirs?: readonly string[];
  readonly mirrorToStderr?: boolean;
}

/** Mutable settings shared by a logger and all its children. */
interface SharedState {
  minLevel: LogLevel;
  sensitiveDirs: readonly string[];
  mirrorToStderr: boolean;
  readonly sink: FileLogSink;
  readonly clock: Clock;
}

export class FileLogger implements Logger {
  readonly #state: SharedState;
  readonly #bindings: LogFields;

  constructor(options: FileLoggerOptions) {
    this.#state = {
      minLevel: options.minLevel ?? 'info',
      sensitiveDirs: [...(options.sensitiveDirs ?? [])],
      mirrorToStderr: options.mirrorToStderr ?? false,
      sink: new FileLogSink(options),
      clock: options.clock ?? systemClock
    };
    this.#bindings = {};
  }

  get file(): string {
    return this.#state.sink.file;
  }

  /** Updates level/redaction/mirroring for this logger and all its children. */
  configure(settings: FileLoggerSettings): void {
    if (settings.minLevel) this.#state.minLevel = settings.minLevel;
    if (settings.sensitiveDirs) this.#state.sensitiveDirs = [...settings.sensitiveDirs];
    if (settings.mirrorToStderr !== undefined) this.#state.mirrorToStderr = settings.mirrorToStderr;
  }

  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new ChildFileLogger(this.#state, { ...this.#bindings, ...bindings });
  }

  flush(): Promise<void> {
    return this.#state.sink.flush();
  }

  /** For fatal paths only (blocks the event loop). */
  flushSync(): void {
    this.#state.sink.flushSync();
  }

  #log(level: LogLevel, message: string, fields: LogFields | undefined): void {
    writeLine(this.#state, level, message, this.#bindings, fields);
  }
}

/** Child logger sharing the parent's sink and settings. */
class ChildFileLogger implements Logger {
  readonly #state: SharedState;
  readonly #bindings: LogFields;

  constructor(state: SharedState, bindings: LogFields) {
    this.#state = state;
    this.#bindings = bindings;
  }

  debug(message: string, fields?: LogFields): void {
    writeLine(this.#state, 'debug', message, this.#bindings, fields);
  }

  info(message: string, fields?: LogFields): void {
    writeLine(this.#state, 'info', message, this.#bindings, fields);
  }

  warn(message: string, fields?: LogFields): void {
    writeLine(this.#state, 'warn', message, this.#bindings, fields);
  }

  error(message: string, fields?: LogFields): void {
    writeLine(this.#state, 'error', message, this.#bindings, fields);
  }

  child(bindings: LogFields): Logger {
    return new ChildFileLogger(this.#state, { ...this.#bindings, ...bindings });
  }
}

function writeLine(
  state: SharedState,
  level: LogLevel,
  message: string,
  bindings: LogFields,
  fields: LogFields | undefined
): void {
  if (RANK[level] < RANK[state.minLevel]) return;
  try {
    const redact = (text: string): string => redactSecrets(text, { sensitiveDirs: state.sensitiveDirs });
    const merged = fields ? { ...bindings, ...fields } : bindings;
    const json = formatFields(merged, redact);
    const text = redact(String(message)).replace(/\r?\n/g, '\\n');
    const line = `${new Date(state.clock.now()).toISOString()} ${level.toUpperCase().padEnd(5)} ${text}${json ? ` ${json}` : ''}`;
    state.sink.write(line);
    if (state.mirrorToStderr) process.stderr.write(`${line}\n`);
  } catch {
    // Logging must never break the caller.
  }
}
