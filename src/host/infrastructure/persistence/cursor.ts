/**
 * Opaque keyset-pagination cursors (base64url JSON). They carry the sort key of
 * the last row of a page; a malformed cursor decodes to `null` (callers answer
 * with an empty page so a broken client cannot loop).
 */
import { v } from '../../../shared/validation/schema.ts';

export interface ConversationCursor {
  readonly updatedAt: number;
  readonly id: string;
}

export interface FileCursor {
  readonly createdAt: number;
  readonly id: number;
}

const ConversationCursorSchema = v.object({
  k: v.literal('c'),
  u: v.number({ int: true }),
  i: v.string({ min: 1, max: 256, noControlChars: false })
});

const FileCursorSchema = v.object({
  k: v.literal('f'),
  c: v.number({ int: true }),
  i: v.number({ int: true, min: 0 })
});

function encode(payload: object): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(cursor: string): unknown {
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  return encode({ k: 'c', u: cursor.updatedAt, i: cursor.id });
}

export function decodeConversationCursor(cursor: string): ConversationCursor | null {
  const parsed = ConversationCursorSchema.parse(decode(cursor));
  return parsed.ok ? { updatedAt: parsed.value.u, id: parsed.value.i } : null;
}

export function encodeFileCursor(cursor: FileCursor): string {
  return encode({ k: 'f', c: cursor.createdAt, i: cursor.id });
}

export function decodeFileCursor(cursor: string): FileCursor | null {
  const parsed = FileCursorSchema.parse(decode(cursor));
  return parsed.ok ? { createdAt: parsed.value.c, id: parsed.value.i } : null;
}

/** Clamps a requested page size to 1..max. */
export function clampLimit(limit: number, max = 1_000): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(Math.trunc(limit), max));
}
