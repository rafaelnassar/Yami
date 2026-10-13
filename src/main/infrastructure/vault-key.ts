/**
 * Data key of the host's secret vault (cookies, Pixiv token).
 *
 * A random 32-byte key is kept in `userData/data/vault/key.bin`, encrypted with
 * Electron `safeStorage` (DPAPI / Keychain / libsecret) when available. Without a real
 * OS keystore it is stored raw with 0600 permissions and `secretsProtected` is false,
 * which the UI surfaces. The key only leaves main inside `system.configure`.
 *
 * File format: magic `YVK1` + mode byte (1 = safeStorage, 0 = raw) + payload.
 *
 * Failures are `VAULT_UNAVAILABLE` with `params.reason` (`VaultUnavailableReason`, read it
 * with `vaultUnavailableReason`); main then configures the host with a disabled vault.
 */
import { randomBytes } from 'node:crypto';
import { VAULT_UNAVAILABLE_REASONS, type VaultUnavailableReason } from '../../shared/contracts/dto.ts';
import { ErrorCode, appError, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import { readBytesIfExists, writeFileAtomicSync } from './atomic-file.ts';
import { describeError, type Logger } from './logger.ts';

/** Subset of Electron's `safeStorage` used here (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface VaultKey {
  /** Base64 of the 32-byte key. */
  readonly keyBase64: string;
  /** True when the key is protected by the OS keystore. */
  readonly protected: boolean;
}

const MAGIC = Buffer.from('YVK1', 'ascii');
const MODE_RAW = 0;
const MODE_SAFE_STORAGE = 1;
const KEY_BYTES = 32;

function unavailable(reason: VaultUnavailableReason): Result<never, AppErrorData> {
  return err(appError(ErrorCode.VAULT_UNAVAILABLE, { reason }));
}

/** The reason carried by a `VaultKeyStore` failure (`io` when it carries none). */
export function vaultUnavailableReason(error: AppErrorData): VaultUnavailableReason {
  const reason = error.params?.['reason'];
  return VAULT_UNAVAILABLE_REASONS.find((known) => known === reason) ?? 'io';
}

export class VaultKeyStore {
  readonly #file: string;
  readonly #safeStorage: SafeStorageLike;
  readonly #platform: NodeJS.Platform;
  readonly #logger: Logger;
  #cached: VaultKey | null = null;

  constructor(file: string, safeStorage: SafeStorageLike, platform: NodeJS.Platform, logger: Logger) {
    this.#file = file;
    this.#safeStorage = safeStorage;
    this.#platform = platform;
    this.#logger = logger;
  }

  /** Last successfully loaded key (for `AppInfo.secretsProtected`). */
  get current(): VaultKey | null {
    return this.#cached;
  }

  load(): Result<VaultKey, AppErrorData> {
    if (this.#cached) return ok(this.#cached);
    try {
      const result = this.#loadOrCreate();
      if (result.ok) this.#cached = result.value;
      return result;
    } catch (error) {
      // Reading or writing key.bin failed (permissions, disk); decryption errors are handled below.
      this.#logger.error('vault key unavailable', describeError(error));
      return unavailable('io');
    }
  }

  /** A keystore that only obfuscates (Linux `basic_text`) does not count as protection. */
  #canProtect(): boolean {
    if (!this.#safeStorage.isEncryptionAvailable()) return false;
    if (this.#platform === 'linux') {
      const backend = this.#safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
      return backend !== 'basic_text' && backend !== 'unknown';
    }
    return true;
  }

  #loadOrCreate(): Result<VaultKey, AppErrorData> {
    const stored = readBytesIfExists(this.#file);
    if (!stored) return ok(this.#create());

    if (stored.length < MAGIC.length + 1 || !stored.subarray(0, MAGIC.length).equals(MAGIC)) {
      // Never overwrite an unknown file: it may be the only copy of the key.
      this.#logger.error('vault key file has an unknown format');
      return unavailable('corrupted');
    }
    const mode = stored[MAGIC.length];
    const payload = stored.subarray(MAGIC.length + 1);

    if (mode === MODE_SAFE_STORAGE) {
      if (!this.#safeStorage.isEncryptionAvailable()) {
        this.#logger.error('OS keystore unavailable; the vault key cannot be decrypted');
        return unavailable('keystore');
      }
      // Decryption can fail when the user denies keychain access: report it (retryable)
      // instead of generating a new key, which would orphan every stored secret.
      let keyBase64: string;
      try {
        keyBase64 = this.#safeStorage.decryptString(Buffer.from(payload));
      } catch (error) {
        this.#logger.error('OS keystore refused to decrypt the vault key', describeError(error));
        return unavailable('keystore');
      }
      if (Buffer.from(keyBase64, 'base64').length !== KEY_BYTES) {
        this.#logger.error('decrypted vault key has an invalid length');
        return unavailable('corrupted');
      }
      return ok({ keyBase64, protected: true });
    }

    if (mode === MODE_RAW && payload.length === KEY_BYTES) {
      const keyBase64 = Buffer.from(payload).toString('base64');
      if (this.#canProtect()) {
        this.#write(keyBase64, true);
        this.#logger.info('vault key upgraded to OS-protected storage');
        return ok({ keyBase64, protected: true });
      }
      return ok({ keyBase64, protected: false });
    }
    this.#logger.error('vault key file is corrupted');
    return unavailable('corrupted');
  }

  #create(): VaultKey {
    const keyBase64 = randomBytes(KEY_BYTES).toString('base64');
    const isProtected = this.#canProtect();
    this.#write(keyBase64, isProtected);
    if (!isProtected) this.#logger.warn('OS keystore unavailable; vault key stored with file permissions only');
    return { keyBase64, protected: isProtected };
  }

  #write(keyBase64: string, protect: boolean): void {
    const payload = protect ? this.#safeStorage.encryptString(keyBase64) : Buffer.from(keyBase64, 'base64');
    const mode = Buffer.from([protect ? MODE_SAFE_STORAGE : MODE_RAW]);
    writeFileAtomicSync(this.#file, Buffer.concat([MAGIC, mode, payload]), { mode: 0o600, dirMode: 0o700 });
  }
}
