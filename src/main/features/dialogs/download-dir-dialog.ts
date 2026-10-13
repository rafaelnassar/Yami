/**
 * `dialogs:choose-download-dir`: localized native folder picker, then the host validates
 * and applies the folder (`settings.setDownloadDir` — the host owns the path sandbox).
 * When opened from the tray panel, blur-to-hide is suspended while the dialog is up.
 */
import type { BrowserWindow } from 'electron';
import type { AppView } from '../../../shared/contracts/ipc.ts';
import type { CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { SettingsReader } from '../../infrastructure/settings-store.ts';
import type { NativeDialogs } from './native-dialogs.ts';

export interface DownloadDirDialogDeps {
  readonly dialogs: NativeDialogs;
  readonly settings: SettingsReader;
  readonly windowFor: (view: AppView) => BrowserWindow | null;
  readonly setTrayDialogOpen: (open: boolean) => void;
  /** Last download dir reported by the host state, if known. */
  readonly currentDownloadDir: () => string | null;
  readonly fallbackDir: string;
  readonly setDownloadDir: (path: string) => Promise<Result<CommandResult<'settings.setDownloadDir'>, AppErrorData>>;
}

export class DownloadDirDialog {
  readonly #deps: DownloadDirDialogDeps;

  constructor(deps: DownloadDirDialogDeps) {
    this.#deps = deps;
  }

  async choose(view: AppView): Promise<Result<{ readonly downloadDir: string } | null, AppErrorData>> {
    const t = translatorFor(this.#deps.settings.get().locale);
    const fromTray = view === 'tray';
    if (fromTray) this.#deps.setTrayDialogOpen(true);
    let selected: string | null;
    try {
      selected = await this.#deps.dialogs.chooseDirectory(this.#deps.windowFor(view), {
        title: t.t('main.dialog.downloadDir.title'),
        buttonLabel: t.t('main.dialog.downloadDir.button'),
        defaultPath: this.#deps.currentDownloadDir() ?? this.#deps.fallbackDir
      });
    } finally {
      if (fromTray) {
        this.#deps.setTrayDialogOpen(false);
        this.#deps.windowFor('tray')?.focus();
      }
    }
    if (selected === null) return ok(null);
    const applied = await this.#deps.setDownloadDir(selected);
    return applied.ok ? ok({ downloadDir: applied.value.downloadDir }) : applied;
  }
}
