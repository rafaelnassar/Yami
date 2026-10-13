/**
 * Cookie file names double as file names on disk (vault entry and the
 * per-download materialized copy), so they are validated strictly: the protocol
 * pattern, no separators/traversal, no hidden files and no Windows device names
 * (`con.txt` would open a device on Windows).
 */
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';

const NAME_PATTERN = /^[\w.@()+ -]+\.txt$/;
const MAX_NAME_LENGTH = 128;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function validateCookieName(name: string): Result<string, AppErrorData> {
  const fail = err(appError(ErrorCode.COOKIES_INVALID_NAME));
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return fail;
  if (!NAME_PATTERN.test(name)) return fail;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return fail;
  if (name.startsWith('.') || name.startsWith(' ') || name.endsWith(' ')) return fail;
  const stem = name.split('.')[0] ?? '';
  if (WINDOWS_RESERVED.test(stem.trim())) return fail;
  return ok(name);
}

export function isValidCookieName(name: string): boolean {
  return validateCookieName(name).ok;
}

/**
 * Best-effort conversion of an arbitrary (legacy) file name into a valid cookie
 * name: unsupported characters become `_` and `.txt` is appended when missing.
 * Returns `null` when nothing usable remains.
 */
export function toCookieName(fileName: string): string | null {
  let base = fileName
    .replace(/[^\w.@()+ -]/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim();
  base = base.replace(/^[.\s]+/, '');
  if (!/\.txt$/i.test(base)) base = `${base}.txt`;
  else base = `${base.slice(0, -4)}.txt`;
  if (base.length > MAX_NAME_LENGTH) base = `${base.slice(0, MAX_NAME_LENGTH - 4).trimEnd()}.txt`;
  return isValidCookieName(base) ? base : null;
}
