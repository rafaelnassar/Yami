/**
 * Application settings owned by the main process (persisted in `userData/settings.json`).
 * Shared by every window through `settings:changed` events — no localStorage syncing.
 * Download-related settings (download dir, default engine, cookies) live in the host.
 */
import { v, type Infer } from '../validation/schema.ts';
import { DOWNLOAD_SCOPES, ENGINES } from '../domain/engine.ts';

export const LOCALES = ['pt', 'en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

export const AppSettingsSchema = v.object(
  {
    version: v.literal(1),
    locale: v.enum(LOCALES),
    /** Blur media from adult sites until hovered/clicked. */
    adultBlur: v.boolean(),
    /** Opt-in: watch the clipboard for links from sites already in the history. */
    clipboardWatch: v.boolean(),
    /** Closing the main window hides it to the tray instead of quitting. */
    closeToTray: v.boolean(),
    /** OS notifications when downloads finish. */
    notifications: v.boolean(),
    /** Check for app updates automatically. */
    autoUpdate: v.boolean(),
    ui: v.object(
      {
        composerEngine: v.object({ single: v.enum(ENGINES), bulk: v.enum(ENGINES) }),
        composerScope: v.enum(DOWNLOAD_SCOPES),
        trayEngine: v.enum(ENGINES),
        sidebarWidth: v.number({ int: true, min: 200, max: 520 })
      },
      { strict: false }
    ),
    /** Set once the legacy `~/.yami` data was imported. */
    legacyImportedAt: v.nullable(v.number({ int: true, min: 0 }))
  },
  { strict: false }
);

export type AppSettings = Infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  locale: 'pt',
  adultBlur: true,
  clipboardWatch: false,
  closeToTray: true,
  notifications: true,
  autoUpdate: true,
  ui: {
    composerEngine: { single: 'gallery-dl', bulk: 'gallery-dl' },
    composerScope: 'single',
    trayEngine: 'gallery-dl',
    sidebarWidth: 288
  },
  legacyImportedAt: null
};

/** Fields a renderer may change (everything except bookkeeping). */
export const AppSettingsPatchSchema = v.object({
  locale: v.optional(v.enum(LOCALES)),
  adultBlur: v.optional(v.boolean()),
  clipboardWatch: v.optional(v.boolean()),
  closeToTray: v.optional(v.boolean()),
  notifications: v.optional(v.boolean()),
  autoUpdate: v.optional(v.boolean()),
  ui: v.optional(
    v.object({
      composerEngine: v.optional(v.object({ single: v.enum(ENGINES), bulk: v.enum(ENGINES) })),
      composerScope: v.optional(v.enum(DOWNLOAD_SCOPES)),
      trayEngine: v.optional(v.enum(ENGINES)),
      sidebarWidth: v.optional(v.number({ int: true, min: 200, max: 520 }))
    })
  )
});

export type AppSettingsPatch = Infer<typeof AppSettingsPatchSchema>;
