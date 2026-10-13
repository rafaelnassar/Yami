/**
 * Main window: frameless (the renderer draws its own title bar), 1280×800, min 960×620,
 * kept inside the display work area, hidden to the tray on close when `closeToTray`.
 */
import { BrowserWindow, screen } from 'electron';
import type { Logger } from '../infrastructure/logger.ts';
import { applyNavigationPolicy } from '../security/navigation-policy.ts';
import { clampToWorkArea } from './geometry.ts';
import { secureWebPreferences } from './secure-web-preferences.ts';

const SIZE = { width: 1280, height: 800 } as const;
const MIN_SIZE = { width: 960, height: 620 } as const;

export interface MainWindowDeps {
  readonly bundleDir: string;
  readonly isPackaged: boolean;
  readonly openDevTools: boolean;
  readonly iconPath: string | null;
  readonly entryUrl: string;
  readonly isAppUrl: (url: string) => boolean;
  readonly openExternal: (url: string) => void;
  /** True while the quit sequence runs: the window must really close then. */
  readonly isQuitting: () => boolean;
  readonly closeToTray: () => boolean;
  /** Called when the user closes the window and it should not hide to the tray. */
  readonly requestQuit: () => void;
  readonly onMaximizedChange: (maximized: boolean) => void;
  readonly logger: Logger;
}

export function clampMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
  const bounds = window.getBounds();
  const work = screen.getDisplayMatching(bounds).workArea;
  const next = clampToWorkArea(bounds, work, MIN_SIZE);
  if (next) window.setBounds(next);
}

export function createMainWindow(deps: MainWindowDeps): BrowserWindow {
  const window = new BrowserWindow({
    ...SIZE,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    center: true,
    frame: false,
    backgroundColor: '#0f090c',
    title: 'Yami',
    ...(deps.iconPath ? { icon: deps.iconPath } : {}),
    webPreferences: secureWebPreferences({ bundleDir: deps.bundleDir, isPackaged: deps.isPackaged })
  });
  window.setMenu(null);
  applyNavigationPolicy(window.webContents, deps);

  window.once('ready-to-show', () => {
    // A quit requested during startup hid everything; a late first paint must not undo it.
    if (deps.isQuitting()) return;
    clampMainWindow(window);
    window.show();
    if (deps.openDevTools && !window.webContents.isDevToolsOpened()) {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  });
  window.on('show', () => clampMainWindow(window));

  window.on('close', (event) => {
    if (deps.isQuitting()) return;
    event.preventDefault();
    if (deps.closeToTray()) window.hide();
    else deps.requestQuit();
  });

  window.on('maximize', () => deps.onMaximizedChange(true));
  window.on('unmaximize', () => deps.onMaximizedChange(false));

  if (!deps.isPackaged) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const toggle =
        input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.shift && (input.control || input.meta));
      if (toggle) {
        event.preventDefault();
        window.webContents.toggleDevTools();
      }
    });
  }

  window.loadURL(deps.entryUrl).catch((error: unknown) => {
    deps.logger.error('main window failed to load', { error: String(error) });
  });
  return window;
}

/** Restores, shows and focuses the main window. */
export function showMainWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
