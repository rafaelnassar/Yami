/** webPreferences shared by every app window (main + tray panel). */
import path from 'node:path';
import type { WebPreferences } from 'electron';

export interface SecureWebPreferencesOptions {
  /** Directory of the main bundle (`__dirname` of `main.cjs`); the preload sits next to it. */
  readonly bundleDir: string;
  readonly isPackaged: boolean;
  readonly backgroundThrottling?: boolean;
}

export function secureWebPreferences(options: SecureWebPreferencesOptions): WebPreferences {
  return {
    preload: path.join(options.bundleDir, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    devTools: !options.isPackaged,
    spellcheck: false,
    backgroundThrottling: options.backgroundThrottling ?? true
  };
}
