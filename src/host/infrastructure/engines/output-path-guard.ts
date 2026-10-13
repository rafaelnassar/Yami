/**
 * Gate applied by the engine parsers before they report a `file` / `pending-file`
 * (the downloads core stats every reported path).
 *
 * Engine output interleaves text chosen by remote sites (titles, uploaders, HTTP
 * reasons), and a crafted title with a newline can forge a whole output line. On
 * Windows, merely stat-ing `\\host\share\…` makes the OS authenticate to that host
 * (NTLM hash leak). The check is purely lexical: it never touches the file system.
 */
import { isInsideDir } from './engine-paths.ts';

/**
 * Output directories a parser may report files from. Empty entries are ignored; no
 * entry at all means "unknown" (only the UNC/device rule applies then).
 */
export type OutputRoots = readonly (string | null | undefined)[];

// eslint-disable-next-line no-control-regex -- control characters in reported paths are rejected on purpose
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Starts at a root: `/`, `\`, or a drive (`C:\`, drive-relative `C:x`). */
const ROOTED = /^(?:[\\/]|[A-Za-z]:)/;
/** `\\host\…`, `//host/…`, `\\.\…`, `\\?\…` and the NT `\??\` prefix (which Win32 passes through). */
const UNC_OR_DEVICE = /^[\\/](?:[\\/]|\?\?[\\/])/;

/** `\\?\C:\x` → `C:\x`, `\\?\UNC\h\s\x` → `\\h\s\x`. Other extended forms stay rooted. */
function withoutExtendedPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(path)) return path.slice(4);
  return path;
}

/**
 * `..` defeats lexical containment. Windows also folds trailing dots/spaces of a
 * segment, so any segment made only of dots and spaces (other than `.`) is refused.
 */
function hasDotSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment !== '.' && /^[. ]+$/.test(segment));
}

/**
 * True when an engine-printed path may be reported as an output:
 * - no control characters and no `..`-like segment;
 * - a relative path is accepted (the core resolves it against its download dir) unless
 *   it carries a drive/scheme colon;
 * - with known roots, a rooted path must lie inside one of them, so a UNC path passes
 *   only when that root is itself on the same share;
 * - with no known root, UNC and device paths are refused.
 */
export function isReportableOutputPath(path: string, roots: OutputRoots): boolean {
  if (!path || CONTROL_CHARS.test(path)) return false;
  const candidate = withoutExtendedPrefix(path);
  if (hasDotSegment(candidate)) return false;
  if (!ROOTED.test(candidate)) return !candidate.includes(':');
  const known = roots.filter((root): root is string => typeof root === 'string' && root.trim() !== '');
  if (known.length === 0) return !UNC_OR_DEVICE.test(candidate);
  return known.some((root) => isInsideDir(candidate, withoutExtendedPrefix(root)));
}
