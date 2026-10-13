/**
 * Turns arbitrary structured log fields into a JSON-safe, redacted object:
 * strings pass through `redact`, secret-looking keys are masked, errors keep a
 * short stack, and depth/size are bounded so a log call can never explode.
 */
import type { LogFields } from '../../application/ports/system.ts';

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 50;
const MAX_KEYS = 50;
const MAX_STRING = 4_000;
const STACK_LINES = 8;
const SECRET_KEY = /(?:pass(?:word|wd)?|secret|token|cookie|authorization|credential|api[-_]?key|session)/i;

export type Redactor = (text: string) => string;

function truncate(text: string): string {
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated]` : text;
}

function sanitizeError(error: Error, redact: Redactor, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: truncate(redact(error.message)) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out['code'] = code;
  if (error.stack) out['stack'] = truncate(redact(error.stack.split('\n').slice(0, STACK_LINES).join('\n')));
  if (error.cause !== undefined && depth < MAX_DEPTH)
    out['cause'] = sanitizeValue(error.cause, redact, depth + 1, seen);
  return out;
}

export function sanitizeValue(value: unknown, redact: Redactor, depth = 0, seen = new WeakSet<object>()): unknown {
  switch (typeof value) {
    case 'string':
      return truncate(redact(value));
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  const object = value as object;
  if (seen.has(object)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  seen.add(object);
  try {
    if (value instanceof Error) return sanitizeError(value, redact, depth, seen);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Array.isArray(value)) {
      const argv = redactArgv(value, redact);
      if (argv) return argv;
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, redact, depth + 1, seen));
      return value.length > MAX_ARRAY_ITEMS ? [...items, `…+${value.length - MAX_ARRAY_ITEMS}`] : items;
    }
    return sanitizeRecord(value as Record<string, unknown>, redact, depth, seen);
  } finally {
    seen.delete(object);
  }
}

/**
 * Argument vectors (`['--password', 'x']`) hide the flag/value pair from per-item
 * redaction, so string arrays are redacted as one newline-joined text.
 */
function redactArgv(value: readonly unknown[], redact: Redactor): string[] | null {
  if (value.length === 0 || value.length > MAX_ARRAY_ITEMS) return null;
  if (!value.every((item): item is string => typeof item === 'string' && !item.includes('\n'))) return null;
  const parts = redact(value.join('\n')).split('\n');
  return parts.length === value.length ? parts.map(truncate) : null;
}

function sanitizeRecord(
  record: Readonly<Record<string, unknown>>,
  redact: Redactor,
  depth: number,
  seen: WeakSet<object>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(record)) {
    if (count >= MAX_KEYS) {
      out['…'] = 'more keys omitted';
      break;
    }
    count += 1;
    if (SECRET_KEY.test(key) && raw !== null && raw !== undefined && typeof raw !== 'boolean') {
      out[key] = '[redacted]';
      continue;
    }
    const value = sanitizeValue(raw, redact, depth + 1, seen);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Sanitized JSON (`''` when there is nothing to print). */
export function formatFields(fields: LogFields | undefined, redact: Redactor): string {
  if (!fields) return '';
  const sanitized = sanitizeRecord(fields, redact, 0, new WeakSet());
  if (Object.keys(sanitized).length === 0) return '';
  try {
    return JSON.stringify(sanitized);
  } catch {
    return '{"fields":"[unserializable]"}';
  }
}
