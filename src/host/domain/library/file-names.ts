/**
 * File-name rules shared by library renames and cookie file names. Names are
 * validated against the strictest platform (Windows) on every OS so a library
 * stays portable and a name accepted on Linux never breaks on Windows.
 */

const WINDOWS_RESERVED_STEMS = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001F\u007F]/;

/** `CON`, `nul.txt`, `COM9.log` are reserved; `console.txt` is not. */
export function isWindowsReservedName(name: string): boolean {
  const stem = (name.split('.')[0] ?? '').trim();
  return WINDOWS_RESERVED_STEMS.test(stem);
}

/** Characters Windows rejects in a file name (plus every control character). */
export function hasForbiddenFileNameChars(name: string): boolean {
  return FORBIDDEN_CHARS.test(name);
}

export function hasPathSeparator(name: string): boolean {
  return name.includes('/') || name.includes('\\');
}

/** Windows silently strips trailing dots/spaces, so such names don't round-trip. */
export function hasTrailingDotOrSpace(name: string): boolean {
  return /[. ]$/.test(name);
}
