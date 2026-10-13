/**
 * `main.log` writer: one line per entry, secrets redacted, rotated at 5 MB keeping 3 files
 * (`main.log`, `main.log.1`, `main.log.2`). Writes are synchronous because the volume is
 * tiny and a crash log must reach the disk before the process dies.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../../shared/domain/redaction.ts';
import type { LogLevel, LogMeta, Logger } from './logger.ts';

export interface FileLoggerOptions {
  readonly dir: string;
  readonly fileName?: string;
  readonly maxBytes?: number;
  /** Total files kept, including the active one. */
  readonly maxFiles?: number;
  /** Paths that must never appear in the log (vault, job workspaces). */
  readonly sensitiveDirs?: readonly string[];
  /** Also print to the console (development). */
  readonly echo?: boolean;
  readonly now?: () => number;
}

const LEVEL_TAG: Readonly<Record<LogLevel, string>> = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

function safeJson(meta: LogMeta): string {
  try {
    return JSON.stringify(meta, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  } catch {
    return '"[unserializable]"';
  }
}

export class FileLogger implements Logger {
  readonly #file: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #sensitiveDirs: readonly string[];
  readonly #echo: boolean;
  readonly #now: () => number;
  readonly #scope: string;
  readonly #state: { size: number; broken: boolean };
  readonly #options: FileLoggerOptions;

  constructor(options: FileLoggerOptions, scope = '', state?: { size: number; broken: boolean }) {
    this.#file = path.join(options.dir, options.fileName ?? 'main.log');
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.#maxFiles = Math.max(1, options.maxFiles ?? 3);
    this.#sensitiveDirs = options.sensitiveDirs ?? [];
    this.#echo = options.echo ?? false;
    this.#now = options.now ?? Date.now;
    this.#scope = scope;
    this.#options = options;
    this.#state = state ?? { size: this.#initialSize(options.dir), broken: false };
  }

  get file(): string {
    return this.#file;
  }

  debug(message: string, meta?: LogMeta): void {
    this.#write('debug', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.#write('info', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.#write('warn', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.#write('error', message, meta);
  }

  child(scope: string): Logger {
    const nested = this.#scope ? `${this.#scope}:${scope}` : scope;
    return new FileLogger(this.#options, nested, this.#state);
  }

  #initialSize(dir: string): number {
    try {
      mkdirSync(dir, { recursive: true });
      return statSync(this.#file).size;
    } catch {
      return 0;
    }
  }

  #write(level: LogLevel, message: string, meta: LogMeta | undefined): void {
    const scope = this.#scope ? ` [${this.#scope}]` : '';
    const raw = `${new Date(this.#now()).toISOString()} ${LEVEL_TAG[level]}${scope} ${message}${meta ? ` ${safeJson(meta)}` : ''}`;
    const line = `${redactSecrets(raw.replace(/\r?\n/g, '\\n'), { sensitiveDirs: this.#sensitiveDirs })}\n`;
    if (this.#echo) {
      // eslint-disable-next-line no-console -- `echo` (development) mirrors every log line to the terminal
      const print = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      print(line.trimEnd());
    }
    if (this.#state.broken) return;
    try {
      const bytes = Buffer.byteLength(line);
      if (this.#state.size + bytes > this.#maxBytes) this.#rotate();
      appendFileSync(this.#file, line);
      this.#state.size += bytes;
    } catch {
      // A broken log must never take the app down; stop trying after the first failure.
      this.#state.broken = true;
    }
  }

  #rotate(): void {
    const oldest = `${this.#file}.${this.#maxFiles - 1}`;
    rmSync(oldest, { force: true });
    for (let index = this.#maxFiles - 2; index >= 1; index -= 1) {
      try {
        renameSync(`${this.#file}.${index}`, `${this.#file}.${index + 1}`);
      } catch {
        // Missing generations are fine.
      }
    }
    if (this.#maxFiles > 1) {
      try {
        renameSync(this.#file, `${this.#file}.1`);
      } catch {
        // Nothing to rotate yet.
      }
    } else {
      rmSync(this.#file, { force: true });
    }
    this.#state.size = 0;
  }
}
