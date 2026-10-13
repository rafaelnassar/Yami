/**
 * One-time import of the data the legacy renderer kept in localStorage (locale, blur,
 * composer engines → AppSettings; folders, folder map, cookie bindings → host).
 * Runs once (`settings.legacyImportedAt === null`); any failure is logged and the
 * import is still marked done so it never blocks or repeats on every start.
 * Deferred while the host runs with a disabled vault: the host defers its own legacy
 * import then (the folder map refers to its conversations) and cookie bindings can only
 * be matched against a readable vault.
 */
import type { AppErrorData } from '../../shared/kernel/errors.ts';
import type { Result } from '../../shared/kernel/result.ts';
import type { CommandResult } from '../../shared/contracts/host-protocol.ts';
import { describeError, type Logger } from './logger.ts';
import { applyLegacyPreferences, hasHostData, parseLegacyUiPayload, type LegacyHostData } from './legacy-ui-payload.ts';
import type { SettingsStore } from './settings-store.ts';

export interface LegacyUiImportDeps {
  readonly settings: Pick<SettingsStore, 'get' | 'updateInternal'>;
  /** Reads the raw legacy localStorage value (hidden window); `null` when absent. */
  readonly readLegacyStorage: () => Promise<string | null>;
  readonly importToHost: (data: LegacyHostData) => Promise<Result<CommandResult<'legacy.importUiData'>, AppErrorData>>;
  readonly now: () => number;
  /** False while the host runs with a disabled vault (the vault key could not be loaded). */
  readonly vaultReady: () => boolean;
  readonly logger: Logger;
}

export class LegacyUiImporter {
  readonly #deps: LegacyUiImportDeps;
  #running: Promise<void> | null = null;

  constructor(deps: LegacyUiImportDeps) {
    this.#deps = deps;
  }

  get needed(): boolean {
    return this.#deps.settings.get().legacyImportedAt === null && this.#deps.vaultReady();
  }

  /** Idempotent; call after the host is ready. */
  run(): Promise<void> {
    if (!this.needed) return Promise.resolve();
    this.#running ??= this.#run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run(): Promise<void> {
    const { logger } = this.#deps;
    let raw: string | null = null;
    try {
      raw = await this.#deps.readLegacyStorage();
    } catch (error) {
      logger.warn('legacy localStorage read failed', describeError(error));
    }

    const legacy = parseLegacyUiPayload(raw);
    if (legacy && hasHostData(legacy.host)) {
      try {
        const result = await this.#deps.importToHost(legacy.host);
        if (result.ok) logger.info('legacy UI data imported', { ...result.value });
        else logger.warn('host rejected legacy UI data', { code: result.error.code });
      } catch (error) {
        logger.warn('legacy UI data import failed', describeError(error));
      }
    }

    const importedAt = this.#deps.now();
    const marked = this.#deps.settings.updateInternal((current) =>
      legacy ? applyLegacyPreferences(current, legacy, importedAt) : { ...current, legacyImportedAt: importedAt }
    );
    if (!marked.ok) logger.warn('could not mark legacy import as done', { code: marked.error.code });
    else logger.info(legacy ? 'legacy preferences imported' : 'no legacy renderer data found');
  }
}
