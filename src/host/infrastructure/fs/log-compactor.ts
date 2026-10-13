/**
 * Bounds the size of a finished job log (engine stdout + stderr). yt-dlp prints a
 * progress line on every progress hook, so one long run can leave hundreds of MB.
 *
 * A log larger than `headBytes + tailBytes` is rewritten as its first `headBytes`
 * (extractor, format selection, first warnings and errors), one marker line saying
 * how much was omitted, and its last `tailBytes` (last files, final errors), both
 * cut on line boundaries. The result is written to a private temp file next to the
 * log and renamed over it, so a crash never leaves a half-written log.
 *
 * Only compact the log of a download that ended: no engine may write it and no
 * reader may tail it (terminal downloads are never re-attached, and a restart
 * truncates the log and reads it again from offset 0).
 */
import { randomBytes } from 'node:crypto';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { errorCodeOf } from './canonical-path.ts';

export interface LogCompactionLimits {
  readonly headBytes: number;
  readonly tailBytes: number;
}

/**
 * - head 64 KiB (≈ 1 000 lines): what the engine resolved before downloading and the
 *   first errors — enough to diagnose a failure that happened at the start;
 * - tail 1 MiB (≈ 10 000 yt-dlp progress lines): the last files and every error of
 *   the end of the run, which the outcome shown to the user was decided on.
 * A finished log is thus capped at ≈ 1.1 MiB; smaller logs (almost all gallery-dl
 * runs) are left untouched.
 */
export const DEFAULT_LOG_COMPACTION: LogCompactionLimits = { headBytes: 64 * 1024, tailBytes: 1024 * 1024 };

export type LogCompaction = 'compacted' | 'unchanged' | 'missing';

/** `.<log name>.<12 hex>.tmp`: the temp file a compaction writes next to the log. */
const TEMP_FILE_PATTERN = /^\.[^/\\]+\.log\.[0-9a-f]{12}\.tmp$/;

/** True for a leftover of an interrupted compaction (crash between write and rename). */
export function isCompactionTempFile(name: string): boolean {
  return TEMP_FILE_PATTERN.test(name);
}

const LF = 0x0a;
const CR = 0x0d;

export async function compactLog(
  file: string,
  limits: LogCompactionLimits = DEFAULT_LOG_COMPACTION
): Promise<LogCompaction> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return 'missing';
    throw error;
  }
  let content: Buffer;
  try {
    const stats = await handle.stat();
    // Windows opens a directory for reading (reporting size 0), POSIX fails on the first read: fail alike.
    if (!stats.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
    const { size } = stats;
    if (size <= limits.headBytes + limits.tailBytes) return 'unchanged';
    // One extra byte on the inner side of each window tells whether its edge line is complete.
    const head = await readAt(handle, 0, limits.headBytes + 1);
    const tail = await readAt(handle, size - limits.tailBytes - 1, limits.tailBytes + 1);
    const keptHead = head.subarray(0, endOfLastLine(head, limits.headBytes));
    const keptTail = tail.subarray(startOfFirstLine(tail));
    const omitted = size - keptHead.length - keptTail.length;
    content = Buffer.concat([keptHead, marker(omitted, keptHead), keptTail]);
  } finally {
    await handle.close().catch(() => undefined);
  }
  await replaceFile(file, content);
  return 'compacted';
}

/** Reads up to `length` bytes at `position` (fewer only at end of file). */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Length of `head` (the window + the byte after it) up to its last line terminator;
 * the raw `limit` bytes when it holds no complete line.
 */
function endOfLastLine(head: Buffer, limit: number): number {
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (head[i] === LF || head[i] === CR) return i + 1;
  }
  return Math.min(limit, head.length);
}

/**
 * Offset of the first complete line of `tail` (the byte before the window + the
 * window; `\r\n` counts as one terminator); the raw window when it holds none.
 */
function startOfFirstLine(tail: Buffer): number {
  for (let i = 0; i < tail.length; i += 1) {
    const byte = tail[i];
    if (byte !== LF && byte !== CR) continue;
    return byte === CR && tail[i + 1] === LF ? i + 2 : i + 1;
  }
  return Math.min(1, tail.length);
}

function marker(omitted: number, head: Buffer): Buffer {
  const last = head.at(-1);
  const newline = head.length > 0 && last !== LF && last !== CR ? '\n' : '';
  return Buffer.from(`${newline}[yami] ... ${omitted} bytes of engine output omitted (log compacted) ...\n`, 'utf8');
}

async function replaceFile(file: string, content: Buffer): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  // 'wx' + 0600 like the log itself: never follows/clobbers an existing entry.
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
