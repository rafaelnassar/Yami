/**
 * Hash-locked wheels for python mode (pure). `npm run runtime:pin` resolves each
 * engine's pinned requirement per platform into the complete list of wheels pip
 * would install (the package and every dependency) with their SHA-256; the host
 * installs exactly that list with `--require-hashes --no-deps`, so neither a
 * floating dependency nor a swapped file on the index can slip in.
 */
import { err, ok, type Result } from '../../../shared/kernel/result.ts';

/** One wheel of a lock (`pythonPackages.<engine>.lock.<platform>[]` in the manifest). */
export interface LockedWheel {
  readonly name: string;
  readonly version: string;
  /** Accepted SHA-256 digests (lower-case hex) of the wheel file(s) for this platform. */
  readonly sha256: readonly string[];
}

/** PEP 503 normalized project name (`Charset_Normalizer` → `charset-normalizer`). */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Version for equality checks: numeric release segments lose leading zeros
 * (`2026.01.15` ≡ `2026.1.15`, as PEP 440 compares them), lower-case.
 */
export function normalizeVersion(version: string): string {
  return version
    .toLowerCase()
    .split('.')
    .map((segment) => (/^\d+$/.test(segment) ? String(Number(segment)) : segment))
    .join('.');
}

/** Distribution name of a requirement without extras (`yt-dlp[default]` → `yt-dlp`). */
export function requirementName(requirement: string): string {
  return requirement.replace(/\[.*$/, '');
}

export interface LockConflict {
  readonly name: string;
  readonly versions: readonly string[];
}

/**
 * Union of several engines' locks for one platform: shared dependencies appear
 * once (their accepted digests merged); the same project at two versions is a
 * conflict (pip would refuse the double requirement).
 */
export function mergeLocks(locks: readonly (readonly LockedWheel[])[]): Result<LockedWheel[], LockConflict> {
  const merged = new Map<string, { name: string; version: string; sha256: Set<string> }>();
  for (const wheel of locks.flat()) {
    const key = normalizePackageName(wheel.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { name: wheel.name, version: wheel.version, sha256: new Set(wheel.sha256) });
      continue;
    }
    if (normalizeVersion(existing.version) !== normalizeVersion(wheel.version)) {
      return err({ name: key, versions: [existing.version, wheel.version] });
    }
    for (const digest of wheel.sha256) existing.sha256.add(digest);
  }
  return ok(
    [...merged.values()].map((wheel) => ({ name: wheel.name, version: wheel.version, sha256: [...wheel.sha256] }))
  );
}

/** Why a lock does not match its pin (`null` when it does): it must lock exactly `<name>==<version>` once. */
export function lockMismatch(lock: readonly LockedWheel[], requirement: string, version: string): string | null {
  const seen = new Set<string>();
  for (const wheel of lock) {
    const key = normalizePackageName(wheel.name);
    if (seen.has(key)) return `duplicate package ${key}`;
    seen.add(key);
  }
  const name = normalizePackageName(requirementName(requirement));
  const top = lock.find((wheel) => normalizePackageName(wheel.name) === name);
  if (!top) return `does not lock ${name}`;
  return normalizeVersion(top.version) === normalizeVersion(version)
    ? null
    : `locks ${name}==${top.version}, pinned ${version}`;
}
