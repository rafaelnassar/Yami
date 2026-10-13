/**
 * Pure settings normalization: salvages every valid field from a (possibly old,
 * partial or corrupted) settings object, falls back to defaults field by field and
 * drops unknown keys. Also applies renderer patches.
 */
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsPatch
} from '../../shared/contracts/app-settings.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accept(candidate: unknown): AppSettings | null {
  const parsed = AppSettingsSchema.parse(candidate);
  return parsed.ok ? parsed.value : null;
}

/**
 * Builds valid `AppSettings` from anything read from disk. Each known field is tried
 * on its own (sub-fields for `ui`), so one bad value never resets the whole file.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  let current: AppSettings = DEFAULT_APP_SETTINGS;
  if (!isRecord(raw)) return current;

  for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>) {
    if (key === 'version' || key === 'ui' || !(key in raw)) continue;
    current = accept({ ...current, [key]: raw[key] }) ?? current;
  }

  const rawUi = raw['ui'];
  if (isRecord(rawUi)) {
    for (const key of Object.keys(DEFAULT_APP_SETTINGS.ui) as Array<keyof AppSettings['ui']>) {
      if (!(key in rawUi)) continue;
      current = accept({ ...current, ui: { ...current.ui, [key]: rawUi[key] } }) ?? current;
    }
  }
  return current;
}

/** Applies a (validated) renderer patch. `ui` is merged one level deep. */
export function applySettingsPatch(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const { ui, ...top } = patch;
  const next: AppSettings = {
    ...current,
    ...top,
    ui: ui ? { ...current.ui, ...ui } : current.ui
  };
  return accept(next) ?? current;
}

/** True when a normalized value differs from what was on disk (so it should be rewritten). */
export function settingsEqual(a: AppSettings, b: AppSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
