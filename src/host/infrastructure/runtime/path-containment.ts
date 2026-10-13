/**
 * Zip-slip protection helpers.
 * - `isUnsafeEntryName`: rejects archive member names that are absolute, carry a
 *   drive letter / UNC prefix, or contain `..` segments (checked before extracting).
 * - `findEscape`: walks an extracted tree (without following links) and reports the
 *   first entry whose real location, or symlink target, is outside the root.
 */
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export function isUnsafeEntryName(name: string): boolean {
  const normalized = name.trim().replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

export function isInside(root: string, candidate: string, pathApi: typeof path = path): boolean {
  const relative = pathApi.relative(root, candidate);
  if (relative === '') return true;
  if (pathApi.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
}

const MAX_ENTRIES = 200_000;

/** Returns the offending path (relative to `root`), or `null` when everything stays inside. */
export async function findEscape(root: string): Promise<string | null> {
  const realRoot = await realpath(root);
  const pending: string[] = [realRoot];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      seen += 1;
      if (seen > MAX_ENTRIES) return '(too many entries)';
      const full = path.join(dir, entry.name);
      const stats = await lstat(full);
      if (stats.isSymbolicLink()) {
        const target = await readlink(full);
        if (!isInside(realRoot, path.resolve(dir, target))) return path.relative(realRoot, full);
        // The lexical target is inside; its real location must be too (chained links).
        const real = await realpath(full).catch(() => null);
        if (real !== null && !isInside(realRoot, real)) return path.relative(realRoot, full);
      } else if (stats.isDirectory()) {
        pending.push(full);
      }
    }
  }
  return null;
}
