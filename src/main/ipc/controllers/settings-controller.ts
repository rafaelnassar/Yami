/** `settings:*` — read and patch app settings (changes are pushed to every window). */
import type { AppSettings } from '../../../shared/contracts/app-settings.ts';
import { IPC } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import { toIpcResult, type IpcRouter } from '../ipc-router.ts';

export interface SettingsControllerDeps {
  readonly get: () => AppSettings;
  /** Validates the untrusted patch (`AppSettingsPatchSchema`) and persists it. */
  readonly update: (patch: unknown) => Result<AppSettings, AppErrorData>;
}

export function registerSettingsController(router: IpcRouter, deps: SettingsControllerDeps): void {
  router.handleValue(IPC.settings.get, () => deps.get());
  router.handleResult(IPC.settings.update, (_ctx, patch) => toIpcResult(deps.update(patch)));
}
