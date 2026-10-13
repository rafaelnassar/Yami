/**
 * Imports the legacy plaintext cookie files (`~/.yami/cookies/*`) into the
 * encrypted `CookieVault`. Only files inside the legacy cookies directory are
 * read (legacy copied any file referenced by `state.json` — spec 02 §9.25).
 * Existing vault entries are never overwritten. The plaintext files are removed
 * later, by `legacy-secret-cleanup.ts`, once the whole import has finished.
 * A retried import passes `saveMissing: false`: it only maps the names of files
 * already in the vault, so a cookie the user removed in between stays removed.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import type { CookieVault } from '../../application/ports/secrets.ts';
import type { Logger } from '../../application/ports/system.ts';
import { toCookieName } from '../security/cookie-name.ts';

export interface CookieImportResult {
  /** Legacy file name → vault name (imported now or already present). */
  readonly names: ReadonlyMap<string, string>;
  readonly imported: number;
  readonly existing: number;
  /** Not imported: invalid, rejected by the vault or (with `saveMissing: false`) not in the vault. */
  readonly invalid: number;
}

export interface LegacyCookieFile {
  /** File name inside the legacy cookies directory. */
  readonly entry: string;
  readonly path: string;
  readonly size: number;
}

/**
 * Non-hidden regular files of `<legacyDir>/cookies`, sorted by name (`[]` when
 * the directory is missing). Hidden entries (`.DS_Store`, editor swap files) are
 * never legacy cookie files.
 */
export async function listLegacyCookieFiles(legacyDir: string): Promise<LegacyCookieFile[]> {
  const dir = path.join(legacyDir, 'cookies');
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const files: LegacyCookieFile[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const file = path.join(dir, entry);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) files.push({ entry, path: file, size: info.size });
  }
  return files;
}

export interface CookieImportOptions {
  /** Save files missing from the vault (default true); `false` only maps existing names. */
  readonly saveMissing?: boolean;
}

export async function importLegacyCookies(
  legacyDir: string,
  vault: CookieVault,
  logger: Logger,
  options: CookieImportOptions = {}
): Promise<CookieImportResult> {
  const names = new Map<string, string>();
  let imported = 0;
  let existing = 0;
  let invalid = 0;
  for (const file of await listLegacyCookieFiles(legacyDir)) {
    const name = toCookieName(file.entry);
    if (!name || file.size > LIMITS.maxCookieFileBytes) {
      invalid += 1;
      continue;
    }
    if (await vault.exists(name)) {
      names.set(file.entry, name);
      existing += 1;
      continue;
    }
    if (options.saveMissing === false) {
      // Invalid at the first attempt, or removed from the vault by the user since: not imported either way.
      invalid += 1;
      continue;
    }
    const saved = await vault.save(name, await readFile(file.path, 'utf8'));
    if (saved.ok) {
      names.set(file.entry, name);
      imported += 1;
    } else {
      invalid += 1;
      logger.warn('legacy cookie file skipped', { file: file.entry, code: saved.error.code });
    }
  }
  return { names, imported, existing, invalid };
}
