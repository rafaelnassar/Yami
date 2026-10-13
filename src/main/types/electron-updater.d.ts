/**
 * Minimal ambient typing for `electron-updater` (loaded lazily by
 * `features/updates/updater-loader.ts`). Only the members Yami uses are declared, so the
 * main process typechecks even where the package is not installed.
 */
declare module 'electron-updater' {
  interface UpdateInfoLike {
    readonly version: string;
  }

  interface ProgressInfoLike {
    readonly percent: number;
  }

  interface AppUpdaterLike {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: 'checking-for-update', listener: () => void): this;
    on(event: 'update-available', listener: (info: UpdateInfoLike) => void): this;
    on(event: 'update-not-available', listener: (info: UpdateInfoLike) => void): this;
    on(event: 'download-progress', listener: (progress: ProgressInfoLike) => void): this;
    on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    checkForUpdates(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  }

  export const autoUpdater: AppUpdaterLike;
}
