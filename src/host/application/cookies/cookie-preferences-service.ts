/**
 * How cookies are chosen for downloads: `cookies.select` (global fallback file),
 * `cookies.setBindings` (site → file rules, now owned by the host instead of the
 * renderer's localStorage) and `cookies.setFromBrowser` (yt-dlp browser cookies).
 * While the vault is disabled (key unavailable) `select` and `setBindings` refuse with
 * VAULT_UNAVAILABLE: the snapshot hides the saved choices then, and replacing them would
 * wipe what comes back once the vault works. Browser cookies do not need the vault.
 */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { CookieVault } from '../ports/secrets.ts';
import type { StateChangeNotifier } from '../session/state-publisher.ts';
import type { SettingsStore } from '../settings/settings-store.ts';
import { normalizeBindings } from './cookie-rules.ts';
import type { CookiesSnapshotBuilder } from './cookies-snapshot.ts';

export interface CookiePreferencesDeps {
  readonly vault: Pick<CookieVault, 'exists' | 'list'>;
  readonly settings: Pick<SettingsStore, 'read' | 'update'>;
  readonly snapshots: Pick<CookiesSnapshotBuilder, 'publishChanged'>;
  readonly state: StateChangeNotifier;
  /** False while the vault is disabled; omitted = always available. */
  readonly vaultReady?: () => boolean;
}

export class CookiePreferencesService {
  readonly #deps: CookiePreferencesDeps;

  constructor(deps: CookiePreferencesDeps) {
    this.#deps = deps;
  }

  /** `null` clears the selection; a name must exist in the vault. */
  async select(
    payload: CommandPayload<'cookies.select'>
  ): Promise<Result<CommandResult<'cookies.select'>, AppErrorData>> {
    const { vault, settings, snapshots, state } = this.#deps;
    const { name } = payload;
    if (!this.#vaultReady()) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    if (name !== null && !(await vault.exists(name))) return err(appError(ErrorCode.COOKIES_NOT_FOUND, { name }));
    if (settings.read().cookies.active !== name) {
      settings.update((current) => ({ ...current, cookies: { ...current.cookies, active: name } }));
      state.stateChanged();
    }
    return ok(await snapshots.publishChanged());
  }

  /** Replaces every binding. All-or-nothing: one unknown cookie file rejects the list. */
  async setBindings(
    payload: CommandPayload<'cookies.setBindings'>
  ): Promise<Result<CommandResult<'cookies.setBindings'>, AppErrorData>> {
    const { vault, settings, snapshots } = this.#deps;
    if (!this.#vaultReady()) return err(appError(ErrorCode.VAULT_UNAVAILABLE));
    const files = await vault.list();
    const bindings = normalizeBindings(payload.bindings, new Set(files.map((file) => file.name)));
    if (!bindings.ok) return bindings;
    settings.update((current) => ({ ...current, cookies: { ...current.cookies, bindings: bindings.value } }));
    return ok(await snapshots.publishChanged(files));
  }

  async setFromBrowser(
    payload: CommandPayload<'cookies.setFromBrowser'>
  ): Promise<Result<CommandResult<'cookies.setFromBrowser'>, AppErrorData>> {
    const { settings, snapshots, state } = this.#deps;
    if (settings.read().cookies.fromBrowser !== payload.enabled) {
      settings.update((current) => ({ ...current, cookies: { ...current.cookies, fromBrowser: payload.enabled } }));
      state.stateChanged();
    }
    return ok(await snapshots.publishChanged());
  }

  #vaultReady(): boolean {
    return this.#deps.vaultReady?.() ?? true;
  }
}
