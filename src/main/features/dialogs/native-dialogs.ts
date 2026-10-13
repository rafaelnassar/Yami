/** Native dialogs behind an interface (Electron `dialog`), parented to the calling window. */
import { dialog, type BrowserWindow } from 'electron';

export interface DirectoryPickerOptions {
  readonly title: string;
  readonly buttonLabel: string;
  readonly defaultPath: string;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface NativeDialogs {
  /** Absolute folder, or `null` when cancelled. */
  chooseDirectory(parent: BrowserWindow | null, options: DirectoryPickerOptions): Promise<string | null>;
  /** True only when the user explicitly confirmed (Cancel is the default button). */
  confirm(parent: BrowserWindow | null, options: ConfirmOptions): Promise<boolean>;
}

export const electronDialogs: NativeDialogs = {
  async chooseDirectory(parent, options) {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: options.title,
      buttonLabel: options.buttonLabel,
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const [selected] = result.filePaths;
    return result.canceled || !selected ? null : selected;
  },
  async confirm(parent, options) {
    const boxOptions: Electron.MessageBoxOptions = {
      type: 'warning',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.confirmLabel, options.cancelLabel],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const result = parent ? await dialog.showMessageBox(parent, boxOptions) : await dialog.showMessageBox(boxOptions);
    return result.response === 0;
  }
};
