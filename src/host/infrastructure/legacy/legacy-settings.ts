/**
 * Applies the legacy `state.json` config to `HostSettings`. Only fields still at
 * their default value are filled, so the import never overrides a choice the
 * user already made in the new app.
 */
import {
  DEFAULT_HOST_SETTINGS,
  type HostSettings,
  type HostSettingsRepository
} from '../../application/ports/persistence.ts';
import type { LegacyConfig } from './legacy-files.ts';
import { legacyCookieName } from './legacy-mapping.ts';

export interface LegacySettingsInput {
  readonly settings: HostSettingsRepository;
  readonly config: LegacyConfig | null;
  readonly cookieNames: ReadonlyMap<string, string>;
  /** Returns the canonical download dir, or `null` when it must not be used. */
  readonly acceptDownloadDir: (dir: string) => Promise<string | null>;
}

/** Returns true when settings were changed. */
export async function mergeLegacySettings(input: LegacySettingsInput): Promise<boolean> {
  const { config } = input;
  if (!config) return false;
  const current = input.settings.load();
  const defaults = DEFAULT_HOST_SETTINGS;
  const downloadDir =
    current.downloadDir === null && config.downloadDir ? await input.acceptDownloadDir(config.downloadDir) : null;
  const activeCookie = legacyCookieName(config.cookiesPath, input.cookieNames);
  const next: HostSettings = {
    ...current,
    downloadDir: current.downloadDir ?? downloadDir,
    defaultEngine:
      current.defaultEngine === defaults.defaultEngine && config.engine ? config.engine : current.defaultEngine,
    runtimeMode:
      current.runtimeMode === defaults.runtimeMode && config.runtimeMode ? config.runtimeMode : current.runtimeMode,
    // Legacy `setupDismissed` is intentionally NOT imported: legacy tools in ~/.yami/bin were never
    // integrity-verified and are not reused, so upgraded users must get the (verified) auto-install.
    setupDismissed: current.setupDismissed,
    cookies: {
      ...current.cookies,
      active: current.cookies.active ?? activeCookie,
      fromBrowser: current.cookies.fromBrowser || config.cookiesFromBrowser
    }
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  input.settings.save(next);
  return true;
}
