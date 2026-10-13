/**
 * `vault:reset` — recovery from a disabled vault (main could not load its key, so the
 * host runs without secrets; see `host-client/configure-payload.ts`).
 *
 * 0. A host that already runs with a working vault is left alone (`recovered`, no restart):
 *    a stale notice or a misbehaving renderer must not be able to bounce the host.
 * 1. The key is tried once more: when it loads now (e.g. the keychain was unlocked), the
 *    host is just restarted with it — nothing is reset (`recovered`).
 * 2. Otherwise a localized native confirmation (Cancel by default) explains that stored
 *    cookie files and the Pixiv login will be lost.
 * 3. With the host stopped, the vault (with `key.bin`) is moved to `*.broken-<timestamp>`
 *    — never deleted — and a new key is created; the host then starts with an empty,
 *    working vault (`reset`). When the new host misses its ready budget the reset itself
 *    is still done (`reset-pending`: the host reports the working vault once it is up).
 * Single-flight: concurrent calls share the same run.
 */
import type { BrowserWindow } from 'electron';
import type { AppView, VaultResetResult } from '../../../shared/contracts/ipc.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { Logger } from '../../infrastructure/logger.ts';
import type { SettingsReader } from '../../infrastructure/settings-store.ts';
import type { VaultKey } from '../../infrastructure/vault-key.ts';
import type { NativeDialogs } from '../dialogs/native-dialogs.ts';

export interface VaultResetDeps {
  /** Whether the running host was configured with a vault key (`CoreServices.hostVaultReady`). */
  readonly hostVaultReady: () => boolean;
  /** `VaultKeyStore.load` (creates a new key when none exists). */
  readonly loadKey: () => Result<VaultKey, AppErrorData>;
  /** Moves the vault aside (`moveVaultAsideSync`); returns the new locations. */
  readonly moveAside: () => Result<readonly string[], AppErrorData>;
  /** `HostClient.restartWith`. */
  readonly restartHost: (whileStopped: () => Promise<void>) => Promise<Result<null, AppErrorData>>;
  readonly dialogs: Pick<NativeDialogs, 'confirm'>;
  readonly settings: SettingsReader;
  readonly windowFor: (view: AppView) => BrowserWindow | null;
  readonly logger: Logger;
}

export class VaultResetService {
  readonly #deps: VaultResetDeps;
  #running: Promise<Result<VaultResetResult, AppErrorData>> | null = null;

  constructor(deps: VaultResetDeps) {
    this.#deps = deps;
  }

  reset(view: AppView): Promise<Result<VaultResetResult, AppErrorData>> {
    this.#running ??= this.#run(view).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run(view: AppView): Promise<Result<VaultResetResult, AppErrorData>> {
    const { logger } = this.#deps;
    if (this.#deps.hostVaultReady()) return ok({ outcome: 'recovered' });
    if (this.#deps.loadKey().ok) {
      logger.info('vault key loads again; restarting the host without a reset');
      const restarted = await this.#deps.restartHost(async () => undefined);
      return restarted.ok ? ok({ outcome: 'recovered' }) : restarted;
    }
    if (!(await this.#confirm(view))) return ok({ outcome: 'cancelled' });

    const run: { ran: boolean; error: AppErrorData | null; recovered: boolean } = {
      ran: false,
      error: null,
      recovered: false
    };
    const restarted = await this.#deps.restartHost(async () => {
      run.ran = true;
      // The key may have become loadable while the dialog was open: then nothing is moved.
      if (this.#deps.loadKey().ok) {
        run.recovered = true;
        return;
      }
      const moved = this.#deps.moveAside();
      if (!moved.ok) {
        run.error = moved.error;
        return;
      }
      const created = this.#deps.loadKey();
      if (!created.ok) run.error = created.error;
      logger.warn('vault moved aside', { moved: moved.value.length, newKey: created.ok });
    });
    // Skipped (old host still alive, app quitting): nothing was touched.
    if (!run.ran) return restarted.ok ? err(appError(ErrorCode.HOST_RESTARTING)) : restarted;
    // The host was restarted either way (still degraded when the reset failed).
    if (run.error) return err(run.error);
    if (run.recovered) return restarted.ok ? ok({ outcome: 'recovered' }) : restarted;
    // The vault is reset on disk; a slow host start does not undo that.
    if (!restarted.ok) logger.warn('vault reset done; the host is still starting', { code: restarted.error.code });
    return ok({ outcome: restarted.ok ? 'reset' : 'reset-pending' });
  }

  #confirm(view: AppView): Promise<boolean> {
    const t = translatorFor(this.#deps.settings.get().locale);
    return this.#deps.dialogs.confirm(this.#deps.windowFor(view), {
      title: t.t('main.dialog.vaultReset.title'),
      message: t.t('main.dialog.vaultReset.message'),
      detail: t.t('main.dialog.vaultReset.detail'),
      confirmLabel: t.t('main.dialog.vaultReset.confirm'),
      cancelLabel: t.t('main.dialog.vaultReset.cancel')
    });
  }
}
