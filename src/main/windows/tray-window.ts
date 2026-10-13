/**
 * Tray quick panel: a transparent, always-on-top window placed next to the tray icon,
 * hidden on blur (180 ms). Clipboard suggestions use `showInactive()` and never steal
 * focus (the legacy panel forced focus on Windows); an unanswered inactive suggestion
 * hides itself after a while instead of floating forever.
 */
import { BrowserWindow, screen } from 'electron';
import { IPC, type ClipboardSuggestionDto } from '../../shared/contracts/ipc.ts';
import type { Logger } from '../infrastructure/logger.ts';
import type { Cancel, Timers } from '../infrastructure/timers.ts';
import { applyNavigationPolicy } from '../security/navigation-policy.ts';
import { placePanelNearTray, type Rect } from './geometry.ts';
import { secureWebPreferences } from './secure-web-preferences.ts';
import type { WindowRegistry } from './window-registry.ts';

const WIDTH = 420;
const DEFAULT_HEIGHT = 148;
const BLUR_HIDE_MS = 180;
const INACTIVE_AUTO_HIDE_MS = 20_000;

export interface TrayWindowDeps {
  readonly bundleDir: string;
  readonly isPackaged: boolean;
  readonly entryUrl: string;
  readonly isAppUrl: (url: string) => boolean;
  readonly openExternal: (url: string) => void;
  readonly isQuitting: () => boolean;
  readonly trayBounds: () => Rect | null;
  readonly registry: WindowRegistry;
  readonly timers: Timers;
  readonly logger: Logger;
}

export class TrayWindow {
  readonly #deps: TrayWindowDeps;
  #window: BrowserWindow | null = null;
  #loaded = false;
  #height = DEFAULT_HEIGHT;
  /** `tray:clipboard-suggestion` + `tray:shown` waiting for the page to finish loading. */
  #pending: { suggestion: ClipboardSuggestionDto | null } | null = null;
  #dialogOpen = false;
  /** Cursor at open time: without tray bounds (Linux) later resizes must not follow the mouse. */
  #cursor: { x: number; y: number } | null = null;
  #cancelBlur: Cancel | null = null;
  #cancelAutoHide: Cancel | null = null;

  constructor(deps: TrayWindowDeps) {
    this.#deps = deps;
  }

  isVisible(): boolean {
    return Boolean(this.#window && !this.#window.isDestroyed() && this.#window.isVisible());
  }

  /** Opens the panel for manual use (focused); clears any previous suggestion. */
  showManual(): void {
    this.#show(null, false);
  }

  /** Opens the panel without taking focus, pre-filled with a clipboard suggestion. */
  showSuggestion(suggestion: ClipboardSuggestionDto): void {
    this.#show(suggestion, true);
  }

  /** Opens the panel focused and pre-filled (URL handed to a second app launch). */
  showUrl(suggestion: ClipboardSuggestionDto): void {
    this.#show(suggestion, false);
  }

  toggleManual(): void {
    if (this.isVisible()) this.hide();
    else this.showManual();
  }

  hide(): void {
    this.#clearTimers();
    this.#dialogOpen = false;
    const window = this.#window;
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
  }

  /** The renderer sizes the panel to its content; the edge next to the tray stays put. */
  setHeight(height: number): void {
    this.#height = Math.round(height);
    const window = this.#window;
    if (window && !window.isDestroyed() && window.isVisible()) this.#position(window);
  }

  /** While a native dialog opened from the panel is up, blur must not hide it. */
  setDialogOpen(open: boolean): void {
    this.#dialogOpen = open;
    if (open) this.#clearTimers();
  }

  get window(): BrowserWindow | null {
    return this.#window && !this.#window.isDestroyed() ? this.#window : null;
  }

  repositionIfVisible(): void {
    const window = this.#window;
    if (window && !window.isDestroyed() && window.isVisible()) this.#position(window);
  }

  destroy(): void {
    this.#clearTimers();
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
    this.#window = null;
  }

  #show(suggestion: ClipboardSuggestionDto | null, inactive: boolean): void {
    // The panel is destroyed when quitting starts; never recreate it during the sequence.
    if (this.#deps.isQuitting()) return;
    const window = this.#ensure();
    this.#clearTimers();
    this.#cursor = screen.getCursorScreenPoint();
    this.#position(window);
    this.#pending = { suggestion };
    if (this.#loaded) this.#flush(window);

    window.setAlwaysOnTop(true, 'screen-saver');
    if (inactive) {
      if (!window.isVisible()) window.showInactive();
      this.#cancelAutoHide = this.#deps.timers.schedule(() => {
        if (!window.isDestroyed() && !window.isFocused()) this.hide();
      }, INACTIVE_AUTO_HIDE_MS);
    } else {
      window.show();
      window.focus();
    }
  }

  #flush(window: BrowserWindow): void {
    const pending = this.#pending;
    if (!pending || window.isDestroyed()) return;
    this.#pending = null;
    window.webContents.send(IPC.tray.clipboardSuggestion, pending.suggestion);
    window.webContents.send(IPC.tray.shown);
  }

  #position(window: BrowserWindow): void {
    const cursor = this.#cursor ?? screen.getCursorScreenPoint();
    const trayBounds = this.#deps.trayBounds();
    const anchorPoint = trayBounds && trayBounds.width > 0 ? { x: trayBounds.x, y: trayBounds.y } : cursor;
    const work = screen.getDisplayNearestPoint(anchorPoint).workArea;
    const size = { width: WIDTH, height: Math.min(this.#height, work.height - 12) };
    const placement = placePanelNearTray({ trayBounds, cursor, work, size });
    window.setBounds({ x: placement.x, y: placement.y, width: size.width, height: size.height }, false);
  }

  #ensure(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const deps = this.#deps;
    const window = new BrowserWindow({
      width: WIDTH,
      height: this.#height,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'Yami',
      webPreferences: secureWebPreferences({
        bundleDir: deps.bundleDir,
        isPackaged: deps.isPackaged,
        backgroundThrottling: false
      })
    });
    window.setMenu(null);
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    applyNavigationPolicy(window.webContents, deps);
    deps.registry.register('tray', window);

    this.#loaded = false;
    window.webContents.on('did-finish-load', () => {
      this.#loaded = true;
      this.#flush(window);
    });
    window.webContents.on('did-start-loading', () => {
      this.#loaded = false;
    });
    window.on('blur', () => this.#onBlur(window));
    window.on('focus', () => this.#clearTimers());
    window.on('close', (event) => {
      // Alt+F4 must not destroy the reusable panel; only quitting does.
      if (deps.isQuitting()) return;
      event.preventDefault();
      this.hide();
    });
    window.on('closed', () => {
      this.#clearTimers();
      if (this.#window === window) this.#window = null;
    });

    window.loadURL(deps.entryUrl).catch((error: unknown) => {
      deps.logger.error('tray panel failed to load', { error: String(error) });
    });
    this.#window = window;
    return window;
  }

  #onBlur(window: BrowserWindow): void {
    if (this.#dialogOpen) return;
    this.#cancelBlur?.();
    this.#cancelBlur = this.#deps.timers.schedule(() => {
      this.#cancelBlur = null;
      if (!this.#dialogOpen && !window.isDestroyed() && !window.isFocused()) this.hide();
    }, BLUR_HIDE_MS);
  }

  #clearTimers(): void {
    this.#cancelBlur?.();
    this.#cancelBlur = null;
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = null;
  }
}
