/**
 * In-memory engine logs. Offsets are line counts (the application treats offsets
 * as opaque numbers, so this is enough to test resume-from-offset behavior).
 */
import type { LogReader, LogReaderFactory } from '../../ports/files.ts';

class FakeLogReader implements LogReader {
  readonly #store: FakeLogStore;
  readonly #file: string;
  #offset: number;
  closed = false;

  constructor(store: FakeLogStore, file: string, offset: number) {
    this.#store = store;
    this.#file = file;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  async readLines(): Promise<string[]> {
    const lines = this.#store.lines(this.#file);
    if (lines.length < this.#offset) this.#offset = 0; // truncated
    const fresh = lines.slice(this.#offset);
    this.#offset = lines.length;
    return fresh;
  }

  async drain(): Promise<string[]> {
    return this.readLines();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeLogStore implements LogReaderFactory {
  readonly #files = new Map<string, string[]>();
  readonly opened: { readonly file: string; readonly offset: number }[] = [];
  failOpen = false;

  open(file: string, offset: number): LogReader {
    if (this.failOpen) throw new Error(`EACCES: ${file}`);
    this.opened.push({ file, offset });
    return new FakeLogReader(this, file, offset);
  }

  append(file: string, lines: readonly string[]): void {
    this.#files.set(file, [...this.lines(file), ...lines]);
  }

  truncate(file: string): void {
    this.#files.set(file, []);
  }

  lines(file: string): readonly string[] {
    return this.#files.get(file) ?? [];
  }
}
