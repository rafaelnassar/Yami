/**
 * Opening files/links with the OS. Every path is first validated by the host
 * (`files.inspect`: canonical path inside the download dir + risk class):
 * - `blocked` (executables, scripts, shortcuts…) → only revealed in the file manager;
 * - `caution` (unknown types) → localized native confirmation, Cancel by default;
 * - `safe` → opened with the default handler.
 */
import type { BrowserWindow } from 'electron';
import type { FileInspectionDto } from '../../../shared/contracts/dto.ts';
import type { AppView, OpenFileResult } from '../../../shared/contracts/ipc.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { SettingsReader } from '../../infrastructure/settings-store.ts';
import { externalUrlOf } from '../../security/navigation-policy.ts';
import type { NativeDialogs } from '../dialogs/native-dialogs.ts';

/** Subset of Electron's `shell`. */
export interface ShellPort {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  openExternal(url: string): Promise<void>;
}

export interface ShellServiceDeps {
  readonly inspect: (path: string) => Promise<Result<FileInspectionDto, AppErrorData>>;
  readonly shell: ShellPort;
  readonly dialogs: Pick<NativeDialogs, 'confirm'>;
  readonly settings: SettingsReader;
  readonly windowFor: (view: AppView) => BrowserWindow | null;
}

export class ShellService {
  readonly #deps: ShellServiceDeps;

  constructor(deps: ShellServiceDeps) {
    this.#deps = deps;
  }

  async openFile(path: string, view: AppView): Promise<Result<OpenFileResult, AppErrorData>> {
    const inspected = await this.#existing(path);
    if (!inspected.ok) return inspected;
    const file = inspected.value;

    if (file.risk === 'blocked') {
      this.#deps.shell.showItemInFolder(file.path);
      return ok({ action: 'revealed' });
    }
    if (file.risk === 'caution') {
      const t = translatorFor(this.#deps.settings.get().locale);
      const confirmed = await this.#deps.dialogs.confirm(this.#deps.windowFor(view), {
        title: t.t('main.dialog.openFile.title'),
        message: t.t('main.dialog.openFile.message', { name: file.name }),
        detail: t.t('main.dialog.openFile.detail'),
        confirmLabel: t.t('main.dialog.openFile.open'),
        cancelLabel: t.t('main.dialog.openFile.cancel')
      });
      if (!confirmed) return ok({ action: 'declined' });
    }
    const failure = await this.#deps.shell.openPath(file.path);
    if (failure) return err(appError(ErrorCode.FILE_OPERATION_FAILED, { detail: failure }));
    return ok({ action: 'opened' });
  }

  async revealFile(path: string): Promise<Result<null, AppErrorData>> {
    const inspected = await this.#existing(path);
    if (!inspected.ok) return inspected;
    this.#deps.shell.showItemInFolder(inspected.value.path);
    return ok(null);
  }

  async openExternal(raw: string): Promise<Result<null, AppErrorData>> {
    const url = externalUrlOf(raw);
    if (!url) return err(appError(ErrorCode.URL_PROTOCOL_NOT_ALLOWED));
    await this.#deps.shell.openExternal(url);
    return ok(null);
  }

  async #existing(path: string): Promise<Result<FileInspectionDto, AppErrorData>> {
    const result = await this.#deps.inspect(path);
    if (!result.ok) return result;
    return result.value.exists ? result : err(appError(ErrorCode.PATH_NOT_FOUND));
  }
}
