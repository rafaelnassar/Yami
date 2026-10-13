/**
 * Incremental reader of engine logs (`LogReaderFactory` / `LogReader`).
 *
 * Lines are split on raw bytes (`\n`, `\r\n` or a lone `\r` — yt-dlp redraws
 * progress with `\r`). 0x0A/0x0D never occur inside a UTF-8 multi-byte
 * sequence, so a character split across two reads is decoded only once its line
 * is complete — the legacy tailer decoded each chunk separately and corrupted it.
 *
 * `offset` is the position right after the last COMPLETE line: resuming a
 * persisted offset re-reads a partial line instead of losing its first part
 * (legacy bug: the offset included the carry).
 */
import { open, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { LogReader, LogReaderFactory } from '../../application/ports/files.ts';
import { Mutex } from '../../../shared/kernel/async.ts';

export interface LogReaderLimits {
  /** Max bytes read per `readLines()` call (default 256 KiB). */
  readonly maxReadBytes?: number;
  /** A line longer than this is emitted truncated and the rest of it discarded (default 64 KiB). */
  readonly maxLineBytes?: number;
  /** Max reads performed by `drain()` (default 512 → 128 MiB). */
  readonly maxDrainReads?: number;
}

const LF = 0x0a;
const CR = 0x0d;

export class NodeLogReaderFactory implements LogReaderFactory {
  readonly #limits: LogReaderLimits;

  constructor(limits: LogReaderLimits = {}) {
    this.#limits = limits;
  }

  open(file: string, offset: number): LogReader {
    return new NodeLogReader(file, offset, this.#limits);
  }
}

interface ChunkResult {
  readonly lines: string[];
  readonly eof: boolean;
}

export class NodeLogReader implements LogReader {
  readonly #file: string;
  readonly #maxRead: number;
  readonly #maxLine: number;
  readonly #maxDrainReads: number;
  readonly #mutex = new Mutex();
  #handle: FileHandle | null = null;
  #closed = false;
  /** Bytes read from the file so far (`#pending` is the unconsumed tail of them). */
  #readPos: number;
  #pending: Buffer = Buffer.alloc(0);
  /** True while skipping the remainder of an over-long line. */
  #discarding = false;

  constructor(file: string, offset: number, limits: LogReaderLimits = {}) {
    this.#file = file;
    this.#readPos = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    this.#maxRead = limits.maxReadBytes ?? 256 * 1024;
    this.#maxLine = limits.maxLineBytes ?? 64 * 1024;
    this.#maxDrainReads = limits.maxDrainReads ?? 512;
  }

  get offset(): number {
    return this.#readPos - this.#pending.length;
  }

  readLines(): Promise<string[]> {
    return this.#mutex.runExclusive(async () => (await this.#readChunk()).lines);
  }

  drain(): Promise<string[]> {
    return this.#mutex.runExclusive(async () => {
      const lines: string[] = [];
      for (let i = 0; i < this.#maxDrainReads; i += 1) {
        const chunk = await this.#readChunk();
        lines.push(...chunk.lines);
        if (chunk.eof) {
          const tail = this.#flushPartial();
          if (tail) lines.push(tail);
          break;
        }
      }
      return lines;
    });
  }

  close(): Promise<void> {
    return this.#mutex.runExclusive(async () => {
      this.#closed = true;
      const handle = this.#handle;
      this.#handle = null;
      await handle?.close().catch(() => undefined);
    });
  }

  async #readChunk(): Promise<ChunkResult> {
    const handle = await this.#open();
    if (!handle) return { lines: [], eof: true };
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch {
      await this.#dropHandle();
      return { lines: [], eof: true };
    }
    if (size < this.#readPos) this.#restart(); // truncated/rewritten (new run of the engine)
    if (size === this.#readPos) return { lines: [], eof: true };

    const length = Math.min(size - this.#readPos, this.#maxRead);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, this.#readPos));
    } catch {
      await this.#dropHandle();
      return { lines: [], eof: true };
    }
    if (bytesRead <= 0) return { lines: [], eof: true };
    this.#readPos += bytesRead;
    this.#pending =
      this.#pending.length > 0
        ? Buffer.concat([this.#pending, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
    return { lines: this.#extractLines(), eof: this.#readPos >= size };
  }

  #extractLines(): string[] {
    const lines: string[] = [];
    const data = this.#pending;
    let start = 0;
    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i];
      if (byte !== LF && byte !== CR) continue;
      this.#emit(data.subarray(start, i), lines);
      // `\r\n` is one terminator; a lone `\r` also ends a line (the `\n` of a split
      // `\r\n` then yields an empty line, which is dropped).
      if (byte === CR && data[i + 1] === LF) i += 1;
      start = i + 1;
    }
    this.#pending = data.subarray(start);
    if (this.#pending.length > this.#maxLine) {
      if (!this.#discarding) lines.push(this.#truncatedLine(this.#pending));
      this.#discarding = true;
      this.#pending = Buffer.alloc(0);
    }
    return lines;
  }

  #emit(bytes: Buffer, lines: string[]): void {
    if (this.#discarding) {
      this.#discarding = false; // this terminator ends the over-long line
      return;
    }
    if (bytes.length === 0) return;
    lines.push(bytes.length > this.#maxLine ? this.#truncatedLine(bytes) : bytes.toString('utf8'));
  }

  /** First `maxLine` bytes, cut on a character boundary (StringDecoder holds back a split character). */
  #truncatedLine(bytes: Buffer): string {
    return new StringDecoder('utf8').write(bytes.subarray(0, this.#maxLine));
  }

  /** Remaining bytes of an unterminated last line (used when the engine exited). */
  #flushPartial(): string | null {
    const rest = this.#pending;
    this.#pending = Buffer.alloc(0);
    if (rest.length === 0 || this.#discarding) {
      this.#discarding = false;
      return null;
    }
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(rest.subarray(0, this.#maxLine)) + decoder.end();
    return text.length > 0 ? text : null;
  }

  #restart(): void {
    this.#readPos = 0;
    this.#pending = Buffer.alloc(0);
    this.#discarding = false;
  }

  async #open(): Promise<FileHandle | null> {
    if (this.#closed) return null;
    if (this.#handle) return this.#handle;
    try {
      this.#handle = await open(this.#file, 'r');
    } catch {
      return null; // not created yet: try again on the next poll
    }
    return this.#handle;
  }

  async #dropHandle(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    await handle?.close().catch(() => undefined);
  }
}
