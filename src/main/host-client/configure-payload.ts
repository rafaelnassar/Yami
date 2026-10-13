/**
 * Builds the `system.configure` payload. A vault key that cannot be loaded no longer
 * keeps the host offline: the host is configured without a key (and with the reason) and
 * runs with a disabled vault — downloads, history and library keep working, secrets do not
 * (see docs/ARCHITECTURE.md §7). Called on every host (re)start, so a key that becomes
 * loadable again (keychain unlocked, vault reset) is picked up by the next start.
 */
import type { AppErrorData } from '../../shared/kernel/errors.ts';
import type { Result } from '../../shared/kernel/result.ts';
import type { AppPaths } from '../infrastructure/app-paths.ts';
import type { Logger } from '../infrastructure/logger.ts';
import { vaultUnavailableReason, type VaultKey } from '../infrastructure/vault-key.ts';
import type { ConfigurePayload } from './host-client.ts';

export interface ConfigureInput {
  readonly paths: Pick<AppPaths, 'dataDir' | 'runtimeDir' | 'logsDir' | 'tempDir' | 'legacyDir' | 'protectedDirs'>;
  readonly loadVaultKey: () => Result<VaultKey, AppErrorData>;
  readonly defaultDownloadDir: string;
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly logger: Logger;
}

export function buildConfigurePayload(input: ConfigureInput): ConfigurePayload {
  const { paths } = input;
  const key = input.loadVaultKey();
  const vault: Pick<ConfigurePayload, 'vaultKey' | 'vaultUnavailable'> = key.ok
    ? { vaultKey: key.value.keyBase64 }
    : { vaultKey: null, vaultUnavailable: vaultUnavailableReason(key.error) };
  if (!key.ok) {
    input.logger.warn('vault key unavailable; the host starts with a disabled vault', {
      reason: vault.vaultUnavailable
    });
  }
  return {
    paths: {
      dataDir: paths.dataDir,
      runtimeDir: paths.runtimeDir,
      logsDir: paths.logsDir,
      tempDir: paths.tempDir,
      legacyDir: paths.legacyDir,
      protectedDirs: [...paths.protectedDirs]
    },
    ...vault,
    defaultDownloadDir: input.defaultDownloadDir,
    isPackaged: input.isPackaged,
    appVersion: input.appVersion
  };
}
