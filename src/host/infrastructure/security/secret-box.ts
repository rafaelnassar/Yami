/**
 * Authenticated encryption for secrets at rest (AES-256-GCM).
 *
 * Blob format: ASCII `YV1` | 12-byte IV | 16-byte auth tag | ciphertext.
 * An optional associated-data label binds a blob to its purpose (e.g. the
 * cookie file name), so swapping two encrypted files is detected as tampering.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';

const MAGIC = Buffer.from('YV1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

export const SECRET_BOX_OVERHEAD = HEADER_BYTES;

function vaultError(reason: string): AppErrorData {
  return appError(ErrorCode.VAULT_UNAVAILABLE, { reason });
}

export class SecretBox {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  /** Validates a base64 data key (must decode to exactly 32 bytes). */
  static fromBase64(keyBase64: string): Result<SecretBox, AppErrorData> {
    const trimmed = keyBase64.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) return err(vaultError('key-format'));
    const key = Buffer.from(trimmed, 'base64');
    if (key.length !== KEY_BYTES) return err(vaultError('key-length'));
    return ok(new SecretBox(key));
  }

  encrypt(plaintext: Buffer | string, associatedData?: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
    if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  /** Fails with `VAULT_UNAVAILABLE` on a foreign format, tampering or a wrong key. */
  decrypt(blob: Buffer, associatedData?: string): Result<Buffer, AppErrorData> {
    if (blob.length < HEADER_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
      return err(vaultError('format'));
    }
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = blob.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      if (associatedData !== undefined) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      return ok(Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]));
    } catch {
      return err(vaultError('authentication'));
    }
  }
}
