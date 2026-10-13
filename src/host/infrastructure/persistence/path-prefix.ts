/**
 * Directory-prefix matching for `MediaFileRepository.renameDirectory`.
 *
 * Legacy bugs fixed here:
 * - the old SQL matched any string prefix, so renaming `/dl/foo` also rewrote
 *   `/dl/foobar/…`; we require `dir` itself or `dir` + separator;
 * - the old SQL used `substr` with UTF-16 lengths on UTF-8 text, corrupting
 *   paths with emoji/astral characters; new paths are computed in JS.
 */

const SEPARATORS = ['/', '\\'] as const;

/** Removes trailing separators (keeps a lone root separator). */
export function trimTrailingSeparators(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed === '' ? dir.slice(0, 1) : trimmed;
}

/** Escapes `%`, `_` and the escape char itself for `LIKE … ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * LIKE patterns that select a superset of the rows under `dir` (SQLite's LIKE is
 * ASCII case-insensitive; non-ASCII code points become `_` so a case-insensitive
 * match on them is not missed). Exact matching is done by `matchDirectory`.
 */
export function directoryLikePatterns(dir: string): string[] {
  let base = '';
  for (const char of dir) base += char.charCodeAt(0) > 0x7f ? '_' : escapeLike(char);
  return [base, ...SEPARATORS.map((sep) => `${base}${escapeLike(sep)}%`)];
}

function sameText(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Returns the part of `path` after `dir` (`''` for the directory itself, or a
 * string starting with a separator), or `null` when `path` is not inside `dir`.
 */
export function matchDirectory(path: string, dir: string, caseInsensitive: boolean): string | null {
  if (path.length < dir.length) return null;
  if (!sameText(path.slice(0, dir.length), dir, caseInsensitive)) return null;
  const rest = path.slice(dir.length);
  if (rest === '') return '';
  return rest.startsWith('/') || rest.startsWith('\\') ? rest : null;
}
