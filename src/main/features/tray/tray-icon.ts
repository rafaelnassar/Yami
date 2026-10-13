/**
 * Tray icon: left click opens the main window, right click toggles the quick panel,
 * tooltip reflects the host state (localized). Linux AppIndicator trays often emit no
 * click events, so there the Open / Quick download / Quit menu is attached as the
 * context menu (the legacy tray was inert on Linux).
 */
import { Menu, Tray, nativeImage } from 'electron';
import type { HostStateDto } from '../../../shared/contracts/dto.ts';
import type { HostConnectionStatus } from '../../../shared/contracts/ipc.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import type { SettingsReader } from '../../infrastructure/settings-store.ts';
import { trayTooltip } from './shell-status.ts';

export interface TrayIconDeps {
  readonly iconPath: string | null;
  readonly platform: NodeJS.Platform;
  readonly settings: SettingsReader;
  readonly openMain: () => void;
  readonly toggleQuickPanel: () => void;
  readonly quit: () => void;
}

export class TrayIcon {
  readonly #deps: TrayIconDeps;
  readonly #tray: Tray;
  #status: HostConnectionStatus = { state: 'starting' };
  #state: HostStateDto | null = null;
  #tooltip = '';

  constructor(deps: TrayIconDeps) {
    this.#deps = deps;
    const image = deps.iconPath ? nativeImage.createFromPath(deps.iconPath) : nativeImage.createEmpty();
    this.#tray = new Tray(deps.platform === 'darwin' ? image.resize({ width: 16, height: 16 }) : image);
    this.#tray.on('click', () => deps.openMain());
    this.#tray.on('right-click', () => deps.toggleQuickPanel());
    this.refreshLocale();
  }

  bounds(): { x: number; y: number; width: number; height: number } | null {
    if (this.#tray.isDestroyed()) return null;
    const bounds = this.#tray.getBounds();
    return bounds.width > 0 && bounds.height > 0 ? bounds : null;
  }

  setHostStatus(status: HostConnectionStatus): void {
    this.#status = status;
    this.#updateTooltip();
  }

  setHostState(state: HostStateDto): void {
    this.#state = state;
    this.#updateTooltip();
  }

  /** Re-renders the menu and tooltip in the current locale. */
  refreshLocale(): void {
    if (this.#tray.isDestroyed()) return;
    if (this.#deps.platform === 'linux') {
      const t = translatorFor(this.#deps.settings.get().locale);
      this.#tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: t.t('main.tray.menu.open'), click: () => this.#deps.openMain() },
          { label: t.t('main.tray.menu.quickDownload'), click: () => this.#deps.toggleQuickPanel() },
          { type: 'separator' },
          { label: t.t('main.tray.menu.quit'), click: () => this.#deps.quit() }
        ])
      );
    }
    this.#tooltip = '';
    this.#updateTooltip();
  }

  destroy(): void {
    if (!this.#tray.isDestroyed()) this.#tray.destroy();
  }

  #updateTooltip(): void {
    if (this.#tray.isDestroyed()) return;
    const text = trayTooltip(this.#status, this.#state, translatorFor(this.#deps.settings.get().locale));
    if (text === this.#tooltip) return;
    this.#tooltip = text;
    this.#tray.setToolTip(text);
  }
}
