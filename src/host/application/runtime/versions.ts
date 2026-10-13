/**
 * Version helpers for tool updates. Tools use two schemes:
 * - date: `2025.11.12` (yt-dlp, gdl-org build tags),
 * - semver-ish: `2.5.6`, `1.32.9`, `7.1.1`.
 * Versions of different schemes are never compared (a gallery-dl date build tag is
 * not "newer" than a semver release).
 */

export type VersionScheme = 'date' | 'semver' | 'unknown';

/** Trims and drops a leading `v`/`V` (GitHub tags). */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

export function versionScheme(value: string): VersionScheme {
  const text = normalizeTag(value);
  if (/^\d{4}\.\d{1,2}\.\d{1,2}(\b|$)/.test(text)) return 'date';
  if (/^\d+\.\d+/.test(text)) return 'semver';
  return 'unknown';
}

/**
 * Extracts the comparable token from noisy `--version` output, e.g.
 * `deno 2.5.6 (stable, release, x86_64)` → `2.5.6`,
 * `ffmpeg version 7.1.1-essentials_build-www.gyan.dev` → `7.1.1`,
 * `Python 3.12.14` → `3.12.14`. Returns `null` when nothing looks like a version.
 */
export function extractVersionToken(value: string | null): string | null {
  if (!value) return null;
  const text = value.trim();
  const date = /\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?/.exec(text);
  if (date) return date[0];
  const semver = /\d+\.\d+(?:\.\d+)?/.exec(text);
  if (semver) return semver[0];
  // Single-number versions (e.g. an ffmpeg `N-12345` nightly) are not comparable.
  return null;
}

function tuple(value: string): number[] {
  return (normalizeTag(value).match(/\d+/g) ?? []).map(Number);
}

/**
 * Compares two versions of the same scheme: negative when `a < b`, 0 when equal,
 * positive when `a > b`, `null` when not comparable.
 */
export function compareVersions(a: string, b: string): number | null {
  if (!a || !b) return null;
  const schemeA = versionScheme(a);
  if (schemeA === 'unknown' || schemeA !== versionScheme(b)) return null;
  const left = tuple(a);
  const right = tuple(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True only when both are comparable and `candidate` is strictly newer. */
export function isNewer(candidate: string | null, current: string | null): boolean {
  if (!candidate || !current) return false;
  const result = compareVersions(candidate, current);
  return result !== null && result > 0;
}

/** The newest of the given versions (comparable ones only; the first wins ties/incomparables). */
export function newestOf(first: string, ...others: readonly (string | null)[]): string {
  let best = first;
  for (const other of others) {
    if (other && isNewer(other, best)) best = other;
  }
  return best;
}
