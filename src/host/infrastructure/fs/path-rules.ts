/**
 * Pure, platform-parameterized path rules used by the path sandbox (no I/O).
 * The platform is injected so Windows rules are testable on Linux (`path.win32`).
 */
import path from 'node:path';
import type { HostPlatform } from '../../application/ports/engines.ts';

export type PathModule = typeof path.posix;

export function pathModuleFor(platform: HostPlatform): PathModule {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Windows file systems compare names case-insensitively. */
export function foldCase(value: string, platform: HostPlatform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

/** `child` is `parent` itself or below it (lexical, after case folding on Windows). */
export function isInsideOrEqual(parent: string, child: string, platform: HostPlatform): boolean {
  const mod = pathModuleFor(platform);
  const rel = mod.relative(foldCase(parent, platform), foldCase(child, platform));
  if (rel === '') return true;
  if (mod.isAbsolute(rel)) return false; // different drive / UNC share
  // Only a real `..` segment escapes; names like `..hidden` are fine (legacy rejected them).
  return rel !== '..' && !rel.startsWith(`..${mod.sep}`);
}

export function samePath(a: string, b: string, platform: HostPlatform): boolean {
  const mod = pathModuleFor(platform);
  return (
    foldCase(stripTrailingSeparators(mod.resolve(a), mod), platform) ===
    foldCase(stripTrailingSeparators(mod.resolve(b), mod), platform)
  );
}

function stripTrailingSeparators(value: string, mod: PathModule): string {
  const root = mod.parse(value).root;
  return value.length > root.length ? value.replace(/[\\/]+$/, '') : value;
}

/** `C:\`, `\\server\share\`, `/`. */
export function isDiskRoot(value: string, platform: HostPlatform): boolean {
  const mod = pathModuleFor(platform);
  const resolved = mod.resolve(value);
  const trim = (text: string): string => text.replace(/[\\/]+$/, '');
  return trim(foldCase(mod.parse(resolved).root, platform)) === trim(foldCase(resolved, platform));
}

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
  'com¹',
  'com²',
  'com³',
  'lpt¹',
  'lpt²',
  'lpt³'
]);

/** `nul.txt`, `COM9.log`, `con ` are reserved device names; `console.txt` is not. */
export function isWindowsReservedName(segment: string): boolean {
  const base = segment.split('.')[0]?.trimEnd().toLowerCase() ?? '';
  return WINDOWS_RESERVED.has(base);
}

/** NTFS alternate data stream (`file.txt:stream`); a leading drive letter is fine. */
export function hasAlternateDataStream(value: string): boolean {
  const rest = /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
  return rest.includes(':');
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** `\\?\`, `\\.\` (and `/` variants) and the NT `\??\` namespace. */
const DEVICE_PREFIX = /^(?:[\\/]{2}[?.](?:[\\/]|$)|\\\?\?\\)/;
const WINDOWS_INVALID_CHARS = /[<>"|?*]/;

export type SyntaxProblem = 'empty' | 'control-chars' | 'device-prefix' | 'ads' | 'reserved-name' | 'invalid-name';

/**
 * Syntactic checks that do not depend on the file system. Returns the problem or
 * `null`. Windows-only rules (ADS, reserved names, trailing dot/space, `<>"|?*`)
 * apply only on win32 — `:` is a legal file name character on POSIX.
 */
export function syntaxProblem(input: string, platform: HostPlatform): SyntaxProblem | null {
  if (input.length === 0 || input.length > 32_767) return 'empty';
  if (CONTROL_CHARS.test(input)) return 'control-chars';
  if (DEVICE_PREFIX.test(input)) return 'device-prefix';
  if (platform !== 'win32') return null;
  if (hasAlternateDataStream(input)) return 'ads';
  const segments = input.split(/[\\/]+/).filter((segment) => segment && segment !== '.' && segment !== '..');
  for (const [index, segment] of segments.entries()) {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) continue;
    if (isWindowsReservedName(segment)) return 'reserved-name';
    // Windows silently strips trailing dots/spaces, so `Yami.` would alias `Yami`.
    if (/[. ]$/.test(segment) || WINDOWS_INVALID_CHARS.test(segment)) return 'invalid-name';
  }
  return null;
}

/**
 * Windows: only `X:\…` and UNC `\\server\share\…` are absolute; drive-relative
 * `X:foo` and rooted `\foo` depend on per-drive process state and are rejected.
 */
export function isFullyQualified(input: string, platform: HostPlatform): boolean {
  if (platform !== 'win32') return input.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(input);
}

/** Windows paths that are neither relative nor fully qualified (`C:foo`, `\foo`). */
export function isAmbiguousWindowsPath(input: string, platform: HostPlatform): boolean {
  if (platform !== 'win32') return false;
  return !isFullyQualified(input, platform) && (/^[A-Za-z]:/.test(input) || /^[\\/]/.test(input));
}
