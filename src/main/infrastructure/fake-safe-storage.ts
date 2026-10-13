/** Test support: `SafeStorageLike` whose availability and decryption can be switched off. */
import type { SafeStorageLike } from './vault-key.ts';

export class FakeSafeStorage implements SafeStorageLike {
  available = true;
  backend = 'gnome_libsecret';
  failDecrypt = false;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plain: string): Buffer {
    return Buffer.from(`enc:${plain}`, 'utf8');
  }
  decryptString(encrypted: Buffer): string {
    if (this.failDecrypt) throw new Error('keychain denied');
    return encrypted.toString('utf8').replace(/^enc:/, '');
  }
  getSelectedStorageBackend(): string {
    return this.backend;
  }
}
