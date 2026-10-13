/**
 * App settings live in main (`settings.json`) and are pushed to every window
 * through `settings:changed`. This store mirrors them; updates are optimistic
 * and reconciled with main's answer. No localStorage.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsPatch
} from '../../../shared/contracts/app-settings.ts';
import type { IpcResult } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';

export interface SettingsStoreState {
  readonly settings: AppSettings;
  readonly loaded: boolean;
  /** The initial `settings.get` failed (defaults stay in use until main pushes settings). */
  readonly loadError: AppErrorData | null;
  receive(settings: AppSettings): void;
  load(): Promise<void>;
  /** Applies a patch optimistically; returns the error (and rolls back) when main rejects it. */
  update(patch: AppSettingsPatch): Promise<AppErrorData | null>;
}

export type SettingsStore = StoreApi<SettingsStoreState>;

export interface SettingsStoreDeps {
  readonly get: () => Promise<IpcResult<AppSettings>>;
  readonly update: (patch: AppSettingsPatch) => Promise<IpcResult<AppSettings>>;
}

/** Deep-enough merge for the settings shape (`ui` and `ui.composerEngine` are nested). */
export function applySettingsPatch(settings: AppSettings, patch: AppSettingsPatch): AppSettings {
  const { ui, ...rest } = patch;
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined)
  ) as Partial<AppSettings>;
  const next: AppSettings = { ...settings, ...defined };
  if (!ui) return next;
  const uiDefined = Object.fromEntries(Object.entries(ui).filter(([, value]) => value !== undefined)) as Partial<
    AppSettings['ui']
  >;
  return { ...next, ui: { ...settings.ui, ...uiDefined } };
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  return createStore<SettingsStoreState>()((set, get) => ({
    settings: DEFAULT_APP_SETTINGS,
    loaded: false,
    loadError: null,
    receive(settings) {
      set({ settings, loaded: true, loadError: null });
    },
    async load() {
      const result = await deps.get();
      if (result.ok) set({ settings: result.data, loaded: true, loadError: null });
      else set({ loadError: result.error });
    },
    async update(patch) {
      const previous = get().settings;
      set({ settings: applySettingsPatch(previous, patch) });
      const result = await deps.update(patch);
      if (result.ok) {
        set({ settings: result.data, loaded: true });
        return null;
      }
      set({ settings: previous });
      return result.error;
    }
  }));
}
