/**
 * Builds the `CookiesSnapshot` returned by every cookies command and carried by
 * `cookies.changed`. References to cookie files that no longer exist (removed
 * outside the app) are hidden, so the UI never offers a dead choice.
 */
import type { CookieFileDto } from '../../../shared/contracts/dto.ts';
import type { CookiesSnapshot } from '../../../shared/contracts/host-protocol.ts';
import type { CookieVault } from '../ports/secrets.ts';
import type { EventSink } from '../ports/system.ts';
import type { SettingsStore } from '../settings/settings-store.ts';

export class CookiesSnapshotBuilder {
  readonly #vault: Pick<CookieVault, 'list'>;
  readonly #settings: Pick<SettingsStore, 'read'>;
  readonly #events: EventSink;

  constructor(vault: Pick<CookieVault, 'list'>, settings: Pick<SettingsStore, 'read'>, events: EventSink) {
    this.#vault = vault;
    this.#settings = settings;
    this.#events = events;
  }

  /** `files` may be passed when the caller already listed the vault. */
  async build(files?: readonly CookieFileDto[]): Promise<CookiesSnapshot> {
    const list = files ?? (await this.#vault.list());
    const names = new Set(list.map((file) => file.name));
    const { cookies } = this.#settings.read();
    return {
      files: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      active: cookies.active !== null && names.has(cookies.active) ? cookies.active : null,
      bindings: cookies.bindings.filter((binding) => names.has(binding.cookieName)),
      fromBrowser: cookies.fromBrowser
    };
  }

  /** Builds the snapshot and publishes `cookies.changed` (after every mutation). */
  async publishChanged(files?: readonly CookieFileDto[]): Promise<CookiesSnapshot> {
    const snapshot = await this.build(files);
    this.#events.publish({ type: 'cookies.changed', cookies: snapshot });
    return snapshot;
  }
}
