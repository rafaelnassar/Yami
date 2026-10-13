/**
 * Deletes the legacy plaintext secrets (`~/.yami/cookies/*` session cookies and
 * the Pixiv refresh token in `credentials.json`) once the encrypted vault
 * provably holds the same secret; otherwise they would stay readable on disk
 * forever. Proof means reading the secret back through the vault: cookie files
 * must match the decrypted vault entry byte for byte, and the vault must return
 * the same Pixiv refresh token. Anything unproven stays where it is and is
 * reported as kept. Nothing else in the legacy dir is ever touched.
 *
 * Never throws: every failure is logged and counted as kept.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CookieVault, CredentialVault } from '../../application/ports/secrets.ts';
import type { Logger } from '../../application/ports/system.ts';
import { describeError } from '../persistence/silent-logger.ts';
import { listLegacyCookieFiles } from './legacy-cookie-import.ts';
import { LEGACY_CREDENTIALS_FILE, readLegacyPixiv } from './legacy-files.ts';

export interface PlaintextCleanupResult {
  readonly removed: number;
  /** Legacy secret files still on disk (unimportable, not matching the vault, or not deletable). */
  readonly kept: number;
}

export interface PlaintextCleanupInput {
  readonly legacyDir: string;
  /** Private scratch space for reading cookies back out of the vault. */
  readonly workDir: string;
  readonly cookies: CookieVault;
  readonly credentials: CredentialVault;
  /** Legacy cookie file name → vault name, as returned by `importLegacyCookies`. */
  readonly cookieNames: ReadonlyMap<string, string>;
  readonly removeFile: (file: string) => Promise<void>;
  readonly logger: Logger;
}

const NOTHING: PlaintextCleanupResult = { removed: 0, kept: 0 };

export async function removeImportedPlaintextSecrets(input: PlaintextCleanupInput): Promise<PlaintextCleanupResult> {
  const cookies = await removeCookieFiles(input);
  const pixiv = await removePixivFile(input);
  return { removed: cookies.removed + pixiv.removed, kept: cookies.kept + pixiv.kept };
}

async function removeCookieFiles(input: PlaintextCleanupInput): Promise<PlaintextCleanupResult> {
  const files = await listLegacyCookieFiles(input.legacyDir);
  const candidates = files.filter((file) => input.cookieNames.has(file.entry));
  if (candidates.length === 0) return { removed: 0, kept: files.length };
  let scratch: string;
  try {
    await mkdir(input.workDir, { recursive: true });
    // mkdtemp creates the directory with mode 0700; `materialize` writes 0600 files into it.
    scratch = await mkdtemp(path.join(input.workDir, 'yami-legacy-verify-'));
  } catch (error) {
    input.logger.warn('legacy cookie files kept: no scratch dir to verify them', { error: describeError(error) });
    return { removed: 0, kept: files.length };
  }
  let removed = 0;
  try {
    for (const file of candidates) {
      const name = input.cookieNames.get(file.entry);
      if (name && (await removeIfStored(input, file.entry, file.path, name, scratch))) removed += 1;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return { removed, kept: files.length - removed };
}

async function removeIfStored(
  input: PlaintextCleanupInput,
  entry: string,
  file: string,
  name: string,
  scratch: string
): Promise<boolean> {
  try {
    const stored = await input.cookies.materialize(name, scratch);
    if (!stored.ok) {
      input.logger.warn('legacy cookie file kept: vault entry unreadable', { file: entry, code: stored.error.code });
      return false;
    }
    const [vaultBytes, legacyBytes] = await Promise.all([readFile(stored.value), readFile(file)]);
    await rm(stored.value, { force: true });
    if (!vaultBytes.equals(legacyBytes)) {
      // Same name, different secret (e.g. two legacy names mapped to one vault name): keep the original.
      input.logger.warn('legacy cookie file kept: vault holds different content', { file: entry, name });
      return false;
    }
    await input.removeFile(file);
    return true;
  } catch (error) {
    input.logger.warn('legacy cookie file could not be removed', { file: entry, error: describeError(error) });
    return false;
  }
}

async function removePixivFile(input: PlaintextCleanupInput): Promise<PlaintextCleanupResult> {
  const legacy = await readLegacyPixiv(input.legacyDir).catch(() => null);
  // No token (disconnected, i.e. `{"pixiv":null}`) or unreadable: nothing identifiable to protect, leave it.
  if (!legacy) return NOTHING;
  try {
    const stored = await input.credentials.getPixiv();
    if (stored?.refreshToken !== legacy.refreshToken) {
      input.logger.warn('legacy Pixiv credentials kept: token not in the vault', { vaultHasPixiv: stored !== null });
      return { removed: 0, kept: 1 };
    }
    await input.removeFile(path.join(input.legacyDir, LEGACY_CREDENTIALS_FILE));
    return { removed: 1, kept: 0 };
  } catch (error) {
    input.logger.warn('legacy Pixiv credentials could not be removed', { error: describeError(error) });
    return { removed: 0, kept: 1 };
  }
}
