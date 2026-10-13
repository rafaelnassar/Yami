/** Cookie files in the vault: `cookies.list`, `cookies.upload`, `cookies.delete`. */
import { LIMITS, type CommandPayload, type CommandResult } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { CookieVault } from '../ports/secrets.ts';
import type { StateChangeNotifier } from '../session/state-publisher.ts';
import type { SettingsStore } from '../settings/settings-store.ts';
import { utf8ByteLength, validateCookieFileName } from './cookie-rules.ts';
import type { CookiesSnapshotBuilder } from './cookies-snapshot.ts';

export interface CookieFilesDeps {
  readonly vault: Pick<CookieVault, 'save' | 'remove'>;
  readonly settings: Pick<SettingsStore, 'update'>;
  readonly snapshots: Pick<CookiesSnapshotBuilder, 'build' | 'publishChanged'>;
  readonly state: StateChangeNotifier;
}

export class CookieFilesService {
  readonly #deps: CookieFilesDeps;

  constructor(deps: CookieFilesDeps) {
    this.#deps = deps;
  }

  async list(): Promise<Result<CommandResult<'cookies.list'>, AppErrorData>> {
    return ok(await this.#deps.snapshots.build());
  }

  /** Stores (or replaces) a Netscape cookie file. It is not selected automatically. */
  async upload(
    payload: CommandPayload<'cookies.upload'>
  ): Promise<Result<CommandResult<'cookies.upload'>, AppErrorData>> {
    const name = validateCookieFileName(payload.name);
    if (!name.ok) return name;
    if (utf8ByteLength(payload.content) > LIMITS.maxCookieFileBytes) {
      return err(appError(ErrorCode.COOKIES_TOO_LARGE, { maxBytes: LIMITS.maxCookieFileBytes }));
    }
    const saved = await this.#deps.vault.save(name.value, payload.content);
    if (!saved.ok) return saved;
    return ok(await this.#deps.snapshots.publishChanged());
  }

  /**
   * Removes the file and every reference to it (active selection and site
   * bindings; the legacy host left bindings pointing to deleted files).
   * Deleting a file that is already gone still cleans the references.
   */
  async delete(
    payload: CommandPayload<'cookies.delete'>
  ): Promise<Result<CommandResult<'cookies.delete'>, AppErrorData>> {
    const { vault, settings, snapshots, state } = this.#deps;
    const { name } = payload;
    const removed = await vault.remove(name);
    if (!removed.ok && removed.error.code !== ErrorCode.COOKIES_NOT_FOUND) return removed;

    let activeCleared = false;
    settings.update((current) => {
      activeCleared = current.cookies.active === name;
      return {
        ...current,
        cookies: {
          ...current.cookies,
          active: activeCleared ? null : current.cookies.active,
          bindings: current.cookies.bindings.filter((binding) => binding.cookieName !== name)
        }
      };
    });
    if (activeCleared) state.stateChanged();
    return ok(await snapshots.publishChanged());
  }
}
