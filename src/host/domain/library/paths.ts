/**
 * Canonical pure path helpers for the host (the application layer cannot import
 * `node:path`). The separator and case rules of the host platform are passed in
 * explicitly (`PathFlavor`), which also keeps Windows behavior testable on Linux.
 *
 * Semantics follow `path.win32` / `path.posix`: Windows flavor accepts both
 * separators, drive roots (`C:\`), rooted paths (`\x`) and UNC shares
 * (`\\server\share`, whose root is the share); POSIX flavor treats `\` as an
 * ordinary file-name character. Normalization is lexical (`.`/`..`, repeated
 * separators); it never touches the filesystem, so the path sandbox (realpath)
 * stays the security boundary.
 */

export type PathSeparator = '/' | '\\';

export interface PathFlavor {
  readonly separator: PathSeparator;
  /** Path comparisons ignore case (Windows, default macOS volumes). */
  readonly caseInsensitive: boolean;
}

export type PlatformName = 'win32' | 'darwin' | 'linux';

export const POSIX_FLAVOR: PathFlavor = { separator: '/', caseInsensitive: false };
/** macOS: POSIX syntax, but default APFS/HFS+ volumes are case-insensitive. */
export const DARWIN_FLAVOR: PathFlavor = { separator: '/', caseInsensitive: true };
export const WINDOWS_FLAVOR: PathFlavor = { separator: '\\', caseInsensitive: true };

export function pathFlavorFor(platform: PlatformName): PathFlavor {
  if (platform === 'win32') return WINDOWS_FLAVOR;
  return platform === 'darwin' ? DARWIN_FLAVOR : POSIX_FLAVOR;
}

/* ───────────────────────────── Parsing ───────────────────────────── */

interface ParsedPath {
  /** `/`, `C:\`, `\`, `\\server\share\`, drive-relative `C:`, or `''` (relative). */
  readonly root: string;
  /** Normalized segments (no `.`, no empty, `..` only at the start of relative paths). */
  readonly segments: readonly string[];
}

const UNC_ROOT = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/;
const DRIVE_ROOT = /^([A-Za-z]:)([\\/])?/;
const DRIVE_RELATIVE_ROOT = /^[A-Za-z]:$/;

function isWindows(flavor: PathFlavor): boolean {
  return flavor.separator === '\\';
}

function splitRoot(path: string, flavor: PathFlavor): { readonly root: string; readonly rest: string } {
  if (!isWindows(flavor)) return path.startsWith('/') ? { root: '/', rest: path } : { root: '', rest: path };
  const unc = UNC_ROOT.exec(path);
  if (unc) return { root: `\\\\${unc[1] ?? ''}\\${unc[2] ?? ''}\\`, rest: path.slice(unc[0].length) };
  const drive = DRIVE_ROOT.exec(path);
  if (drive) {
    const letter = drive[1] ?? '';
    return { root: drive[2] ? `${letter}\\` : letter, rest: path.slice(drive[0].length) };
  }
  return /^[\\/]/.test(path) ? { root: '\\', rest: path } : { root: '', rest: path };
}

/** `..` may climb out of relative (and drive-relative) paths but never above an absolute root. */
function climbsFreely(root: string): boolean {
  return root === '' || DRIVE_RELATIVE_ROOT.test(root);
}

function parse(path: string, flavor: PathFlavor): ParsedPath {
  const { root, rest } = splitRoot(path, flavor);
  const segments: string[] = [];
  for (const segment of rest.split(isWindows(flavor) ? /[\\/]+/ : /\/+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      segments.push(segment);
    } else if (segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop();
    } else if (climbsFreely(root)) {
      segments.push(segment);
    }
  }
  return { root, segments };
}

function format({ root, segments }: ParsedPath, flavor: PathFlavor): string {
  if (segments.length > 0) return `${root}${segments.join(flavor.separator)}`;
  // A bare UNC share is written without its trailing separator (`\\server\share`).
  return root.startsWith('\\\\') ? root.slice(0, -1) : root;
}

function comparisonKey(text: string, flavor: PathFlavor): string {
  return flavor.caseInsensitive ? text.toLowerCase() : text;
}

/* ───────────────────────────── Syntax ───────────────────────────── */

/** Converts every separator to the flavor's separator (Windows accepts both). */
export function normalizeSeparators(path: string, flavor: PathFlavor): string {
  return isWindows(flavor) ? path.replace(/\//g, '\\') : path;
}

/**
 * True for `/x`, `\x`, `\\server\share`, `C:\x` and `C:/x`. Without a flavor every
 * form is accepted (conservative: never joined under another directory); with
 * the POSIX flavor only `/x` is absolute.
 */
export function isAbsolutePath(path: string, flavor?: PathFlavor): boolean {
  if (flavor && !isWindows(flavor)) return path.startsWith('/');
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Lexical normalization: flavor separators, repeated separators collapsed, `.`
 * removed, `..` resolved (never above an absolute root), trailing separators
 * trimmed (roots keep theirs: `/`, `C:\`). A relative path that resolves to
 * nothing (`a/..`) becomes `''`.
 */
export function normalizePath(path: string, flavor: PathFlavor): string {
  return format(parse(path, flavor), flavor);
}

/** Length of the root prefix that must keep its trailing separator (`/`, `C:\`, `\\`). */
function rootLength(path: string): number {
  if (/^[A-Za-z]:[\\/]/.test(path)) return 3;
  if (path.startsWith('\\\\')) return 2;
  if (path.startsWith('/') || path.startsWith('\\')) return 1;
  return 0;
}

/** Removes trailing separators (either kind), never shortening a root (`/`, `C:\`). */
export function trimTrailingSeparators(path: string): string {
  const keep = rootLength(path);
  let end = path.length;
  while (end > keep && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;
  return path.slice(0, end);
}

/**
 * Joins `child` under `base` and normalizes the result. `child` is always
 * treated as relative (leading separators are ignored); `..` in it is resolved
 * lexically, so check containment afterwards when the child is untrusted.
 */
export function joinPath(base: string, child: string, flavor: PathFlavor): string {
  const tail = child.replace(isWindows(flavor) ? /^[\\/]+/ : /^\/+/, '');
  if (base === '') return normalizePath(tail, flavor);
  return normalizePath(tail ? `${base}${flavor.separator}${tail}` : base, flavor);
}

/**
 * Resolves `path` against `base` when relative (`./x`, `.\x`, `x/y`), like an
 * engine printing paths relative to its working directory; absolute paths are
 * only normalized. Lexical, like `path.resolve` without the process cwd.
 */
export function resolveAgainst(base: string, path: string, flavor: PathFlavor): string {
  return isAbsolutePath(path, flavor) ? normalizePath(path, flavor) : joinPath(base, path, flavor);
}

/**
 * Parent directory (`/a/b` → `/a`, `/a` → `/`, `C:\a` → `C:\`,
 * `\\srv\share\a` → `\\srv\share`); a root is its own parent, a bare name has `''`.
 */
export function parentPath(path: string, flavor: PathFlavor): string {
  const parsed = parse(path, flavor);
  return format({ root: parsed.root, segments: parsed.segments.slice(0, -1) }, flavor);
}

/** Last path segment, either separator (`/a/b/` → `b`); `''` for a root. */
export function lastSegment(path: string): string {
  const normalized = trimTrailingSeparators(path);
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** `a\b\c` → `a/b/c` (relative paths shown to the UI always use `/`). */
export function toPosixSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/* ─────────────────────────── Comparisons ─────────────────────────── */

/**
 * Segments of `candidate` below `root` (`[]` when equal), or `null` when the
 * candidate is not inside the root. Both are normalized first and compared
 * segment by segment with the flavor's case rule, so `/dl/foobar` is never
 * inside `/dl/foo` and `/dl/../etc` is not inside `/dl`. Returned segments keep
 * the candidate's case.
 */
export function relativeSegments(root: string, candidate: string, flavor: PathFlavor): string[] | null {
  const base = parse(root, flavor);
  const target = parse(candidate, flavor);
  if (comparisonKey(base.root, flavor) !== comparisonKey(target.root, flavor)) return null;
  if (target.segments.length < base.segments.length) return null;
  for (const [index, segment] of base.segments.entries()) {
    if (comparisonKey(segment, flavor) !== comparisonKey(target.segments[index] ?? '', flavor)) return null;
  }
  return target.segments.slice(base.segments.length);
}

export function samePath(a: string, b: string, flavor: PathFlavor): boolean {
  return relativeSegments(a, b, flavor)?.length === 0;
}

/** True when `candidate` is `root` itself or below it. */
export function isSameOrInside(root: string, candidate: string, flavor: PathFlavor): boolean {
  return relativeSegments(root, candidate, flavor) !== null;
}

/** True when `candidate` is any of `roots` or below one of them (empty roots are ignored). */
export function isInsideAny(roots: readonly string[], candidate: string, flavor: PathFlavor): boolean {
  return roots.some((root) => root !== '' && isSameOrInside(root, candidate, flavor));
}
