/**
 * Knows the app windows (main + tray panel): used by the IPC sender policy and to
 * broadcast events to every window (the legacy app never sent events to the tray).
 */
import type { BrowserWindow } from 'electron';
import type { AppView } from '../../shared/contracts/ipc.ts';

export class WindowRegistry {
  readonly #windows = new Map<AppView, BrowserWindow>();

  register(view: AppView, window: BrowserWindow): void {
    this.#windows.set(view, window);
    window.once('closed', () => {
      if (this.#windows.get(view) === window) this.#windows.delete(view);
    });
  }

  get(view: AppView): BrowserWindow | null {
    const window = this.#windows.get(view);
    return window && !window.isDestroyed() ? window : null;
  }

  viewOf(webContentsId: number): AppView | null {
    for (const [view, window] of this.#windows) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) return view;
    }
    return null;
  }

  send(view: AppView, channel: string, payload?: unknown): void {
    const window = this.get(view);
    if (!window || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const view of this.#windows.keys()) this.send(view, channel, payload);
  }
}
