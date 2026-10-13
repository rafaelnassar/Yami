/** HTTP `Range` parsing for the media protocol (single byte range only). */

export type ByteRange =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * - no header / multi-range / other units → `full` (ignoring Range is allowed by RFC 9110);
 * - `bytes=a-b`, `bytes=a-`, `bytes=-n` → `partial` (end clamped to `size - 1`);
 * - malformed or out-of-bounds single ranges, or any range on an empty file → `unsatisfiable`.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: 'full' };
  const value = header.trim().replace(/\s+/g, '');
  if (!value.toLowerCase().startsWith('bytes=') || value.includes(',')) return { kind: 'full' };
  const match = SINGLE_RANGE.exec(value.toLowerCase());
  if (!match) return { kind: 'unsatisfiable' };
  const [, rawStart = '', rawEnd = ''] = match;
  if (size <= 0) return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    if (rawEnd === '') return { kind: 'unsatisfiable' };
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'partial', start, end };
}
