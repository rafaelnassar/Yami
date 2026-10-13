/**
 * Append-only, size-rotated log file with asynchronous buffered writes.
 *
 * `host.log` rotates at `maxBytes`: `host.log` → `host.log.1` → … keeping
 * `maxFiles` files in total. Writes are batched on a short timer; `flushSync()`
 * exists for fatal paths (uncaught exception) where the process is about to die.
 * A logging failure never throws into the caller.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export interface FileLogSinkOptions {
  readonly logsDir: string;
  readonly fileName?: string;
  /** Rotation threshold (default 5 MiB). */
  readonly maxBytes?: number;
  /** Files kept in total, including the active one (default 3, min 2). */
  readonly maxFiles?: number;
  /** Batching delay for async writes (default 100 ms). */
  readonly flushDelayMs?: number;
  /** Lines kept in memory while the disk is slow; older ones are dropped (default 10 000). */
  readonly maxPendingLines?: number;
}

export class FileLogSink {
  readonly file: string;
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #flushDelayMs: number;
  readonly #maxPending: number;
  #pending: string[] = [];
  #dropped = 0;
  #size: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> | null = null;

  constructor(options: FileLogSinkOptions) {
    this.#dir = options.logsDir;
    this.file = path.join(options.logsDir, options.fileName ?? 'host.log');
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.#maxFiles = Math.max(2, options.maxFiles ?? 3);
    this.#flushDelayMs = options.flushDelayMs ?? 100;
    this.#maxPending = options.maxPendingLines ?? 10_000;
  }

  /** Queues one complete line (without the trailing newline). */
  write(line: string): void {
    this.#pending.push(line);
    if (this.#pending.length > this.#maxPending) {
      this.#pending.shift();
      this.#dropped += 1;
    }
    this.#schedule();
  }

  /** Writes everything queued so far (awaits an in-flight write first). */
  async flush(): Promise<void> {
    this.#clearTimer();
    while (this.#writing) await this.#writing;
    if (this.#pending.length === 0) return;
    this.#writing = this.#writeAsync(this.#takeChunk()).finally(() => {
      this.#writing = null;
      if (this.#pending.length > 0) this.#schedule();
    });
    await this.#writing;
    if (this.#pending.length > 0) await this.flush();
  }

  /** Synchronous flush for fatal paths only (the event loop may never run again). */
  flushSync(): void {
    this.#clearTimer();
    if (this.#pending.length === 0) return;
    const chunk = this.#takeChunk();
    try {
      mkdirSync(this.#dir, { recursive: true });
      const size = this.#size ?? safeSizeSync(this.file);
      if (size > 0 && size + Buffer.byteLength(chunk) > this.#maxBytes) {
        this.#rotateSync();
        this.#size = 0;
      } else {
        this.#size = size;
      }
      appendFileSync(this.file, chunk, { encoding: 'utf8', mode: 0o600 });
      this.#size = (this.#size ?? 0) + Buffer.byteLength(chunk);
    } catch {
      // Nothing sensible left to do on a fatal path.
    }
  }

  #schedule(): void {
    if (this.#timer || this.#writing) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#flushDelayMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #takeChunk(): string {
    const lines = this.#pending;
    this.#pending = [];
    if (this.#dropped > 0) {
      lines.unshift(`${new Date().toISOString()} WARN  log buffer overflow {"dropped":${this.#dropped}}`);
      this.#dropped = 0;
    }
    return `${lines.join('\n')}\n`;
  }

  async #writeAsync(chunk: string): Promise<void> {
    const bytes = Buffer.byteLength(chunk);
    try {
      await mkdir(this.#dir, { recursive: true });
      this.#size ??= await stat(this.file).then(
        (info) => info.size,
        () => 0
      );
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
        await this.#rotate();
        this.#size = 0;
      }
      await appendFile(this.file, chunk, { encoding: 'utf8', mode: 0o600 });
      this.#size += bytes;
    } catch {
      this.#size = null; // re-stat next time
    }
  }

  async #rotate(): Promise<void> {
    for (let i = this.#maxFiles - 1; i >= 1; i -= 1) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      await rename(from, `${this.file}.${i}`).catch(() => undefined);
    }
  }

  #rotateSync(): void {
    for (let i = this.#maxFiles - 1; i >= 1; i -= 1) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      try {
        renameSync(from, `${this.file}.${i}`);
      } catch {
        // missing generation: nothing to shift
      }
    }
  }
}

function safeSizeSync(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
