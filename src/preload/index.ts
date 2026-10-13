/**
 * Preload for every app window (bundled into `dist-electron/preload.cjs`, sandboxed).
 * Exposes `window.yami: YamiApi` — a thin mapping of calls to IPC channels, no logic.
 * Listeners never receive the `IpcRendererEvent` (it would leak `sender`).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, AppSettingsPatch } from '../shared/contracts/app-settings.ts';
import type { HostEvent } from '../shared/contracts/host-protocol.ts';
import {
  IPC,
  type AppView,
  type ClipboardSuggestionDto,
  type HostConnectionStatus,
  type Unsubscribe,
  type UpdateStatus,
  type YamiApi
} from '../shared/contracts/ipc.ts';
import { blockFileDrops, currentSearch } from './dom.ts';

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function platformOf(value: string): YamiApi['platform'] {
  return value === 'win32' || value === 'darwin' ? value : 'linux';
}

const view: AppView = new URLSearchParams(currentSearch()).get('view') === 'tray' ? 'tray' : 'main';

const api: YamiApi = {
  view,
  platform: platformOf(process.platform),

  host: {
    request: (command, payload) => ipcRenderer.invoke(IPC.host.request, { command, payload }),
    onEvent: (listener) => subscribe<HostEvent>(IPC.host.event, listener),
    getStatus: () => ipcRenderer.invoke(IPC.host.getStatus),
    onStatus: (listener) => subscribe<HostConnectionStatus>(IPC.host.status, listener),
    restart: () => ipcRenderer.invoke(IPC.host.restart)
  },

  app: {
    getInfo: () => ipcRenderer.invoke(IPC.app.getInfo),
    quit: () => ipcRenderer.send(IPC.app.quit)
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    update: (patch: AppSettingsPatch) => ipcRenderer.invoke(IPC.settings.update, patch),
    onChanged: (listener) => subscribe<AppSettings>(IPC.settings.changed, listener)
  },

  window: {
    minimize: () => ipcRenderer.send(IPC.window.minimize),
    toggleMaximize: () => ipcRenderer.send(IPC.window.toggleMaximize),
    close: () => ipcRenderer.send(IPC.window.close),
    isMaximized: () => ipcRenderer.invoke(IPC.window.isMaximized),
    onMaximizedChange: (listener) => subscribe<boolean>(IPC.window.maximizedChanged, listener),
    showMain: () => ipcRenderer.send(IPC.window.showMain)
  },

  tray: {
    hide: () => ipcRenderer.send(IPC.tray.hide),
    setHeight: (height) => ipcRenderer.send(IPC.tray.setHeight, { height }),
    onShown: (listener) => subscribe<undefined>(IPC.tray.shown, () => listener()),
    onClipboardSuggestion: (listener) =>
      subscribe<ClipboardSuggestionDto | null>(IPC.tray.clipboardSuggestion, listener),
    dismissSuggestion: (url) => ipcRenderer.send(IPC.tray.dismissSuggestion, { url })
  },

  dialogs: {
    chooseDownloadDir: () => ipcRenderer.invoke(IPC.dialogs.chooseDownloadDir)
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.shell.openExternal, { url }),
    openFile: (path) => ipcRenderer.invoke(IPC.shell.openFile, { path }),
    revealFile: (path) => ipcRenderer.invoke(IPC.shell.revealFile, { path })
  },

  media: {
    preview: (path) => ipcRenderer.invoke(IPC.media.preview, { path }),
    thumbnail: (path, size) => ipcRenderer.invoke(IPC.media.thumbnail, { path, size })
  },

  clipboard: {
    readUrls: () => ipcRenderer.invoke(IPC.clipboard.readUrls)
  },

  accounts: {
    connect: (siteId: string) => ipcRenderer.invoke(IPC.accounts.connect, { siteId }),
    disconnect: (siteId: string) => ipcRenderer.invoke(IPC.accounts.disconnect, { siteId }),
    saveApiKey: (siteId: string, credentials: string) =>
      ipcRenderer.invoke(IPC.accounts.saveApiKey, { siteId, credentials }),
    connectPixiv: () => ipcRenderer.invoke(IPC.accounts.connectPixiv),
    disconnectPixiv: () => ipcRenderer.invoke(IPC.accounts.disconnectPixiv)
  },

  vault: {
    reset: () => ipcRenderer.invoke(IPC.vault.reset)
  },

  updates: {
    getStatus: () => ipcRenderer.invoke(IPC.updates.getStatus),
    check: () => ipcRenderer.invoke(IPC.updates.check),
    install: () => ipcRenderer.invoke(IPC.updates.install),
    onStatus: (listener) => subscribe<UpdateStatus>(IPC.updates.status, listener)
  }
};

contextBridge.exposeInMainWorld('yami', api);
blockFileDrops();
