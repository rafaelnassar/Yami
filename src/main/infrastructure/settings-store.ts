/**
 * `userData/settings.json` — the single source of truth for app settings. Every
 * window receives changes through `settings:changed` (no localStorage syncing).
 */
import { renameSync } from 'node:fs';
import { AppSettingsPatchSchema, type AppSettings } from '../../shared/contracts/app-settings.ts';
import { ErrorCode, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import { readTextIfExists, writeFileAtomicSync } from './atomic-file.ts';
import { describeError, type Logger } from './logger.ts';
import { applySettingsPatch, normalizeSettings, settingsEqual } from './settings-merge.ts';

export type SettingsListener = (settings: AppSettings, previous: AppSettings) => void;

export interface SettingsReader {
  get(): AppSettings;
  onChange(listener: SettingsListener): () => void;
}

export class SettingsStore implements SettingsReader {
  readonly #file: string;
  readonly #logger: Logger;
  readonly #listeners = new Set<SettingsListener>();
  #current: AppSettings;

  constructor(file: string, logger: Logger) {
    this.#file = file;
    this.#logger = logger;
    this.#current = this.#load();
  }

  get(): AppSettings {
    return this.#current;
  }

  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Validates and applies a renderer patch (untrusted input). */
  update(rawPatch: unknown): Result<AppSettings, AppErrorData> {
    const parsed = AppSettingsPatchSchema.parse(rawPatch);
    if (!parsed.ok)
      return err({ code: ErrorCode.VALIDATION_FAILED, params: { path: parsed.error.path || 'settings' } });
    return this.#commit(applySettingsPatch(this.#current, parsed.value));
  }

  /** Main-only changes (bookkeeping fields such as `legacyImportedAt`). */
  updateInternal(change: (current: AppSettings) => AppSettings): Result<AppSettings, AppErrorData> {
    return this.#commit(normalizeSettings(change(this.#current)));
  }

  #commit(next: AppSettings): Result<AppSettings, AppErrorData> {
    const previous = this.#current;
    if (settingsEqual(previous, next)) return ok(previous);
    try {
      this.#persist(next);
    } catch (error) {
      this.#logger.error('settings write failed', describeError(error));
      return err({ code: ErrorCode.FILE_OPERATION_FAILED, params: { detail: 'settings' } });
    }
    this.#current = next;
    for (const listener of this.#listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        this.#logger.error('settings listener failed', describeError(error));
      }
    }
    return ok(next);
  }

  #load(): AppSettings {
    let text: string | null = null;
    try {
      text = readTextIfExists(this.#file);
    } catch (error) {
      this.#logger.warn('settings read failed; using defaults', describeError(error));
    }
    if (text === null) return normalizeSettings(undefined);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#quarantine();
      return normalizeSettings(undefined);
    }
    const settings = normalizeSettings(raw);
    if (JSON.stringify(raw) !== JSON.stringify(settings)) {
      // Drops unknown/invalid keys and fills new defaults so the file stays canonical.
      try {
        this.#persist(settings);
      } catch (error) {
        this.#logger.warn('settings migration write failed', describeError(error));
      }
    }
    return settings;
  }

  /** Keeps an unparseable file for diagnosis instead of silently overwriting it. */
  #quarantine(): void {
    try {
      renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      this.#logger.warn('settings file was corrupted; moved aside and reset to defaults');
    } catch (error) {
      this.#logger.warn('could not move corrupted settings file', describeError(error));
    }
  }

  #persist(settings: AppSettings): void {
    writeFileAtomicSync(this.#file, `${JSON.stringify(settings, null, 2)}\n`);
  }
}
