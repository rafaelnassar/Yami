/**
 * Renderer ⇄ main contract.
 *
 * The preload script exposes `window.yami: YamiApi` (see `src/preload`). Every
 * method maps to exactly one IPC channel below. Main validates the sender frame
 * (must be the app origin) and the payload schema of every call.
 *
 * All invoke-style calls resolve to `IpcResult<T>` — they never reject for
 * expected failures, so errors keep their `code`/`params` structure across IPC.
 */
import type { AppErrorData } from '../kernel/errors.ts';
import { v } from '../validation/schema.ts';
import type { AppSettings, AppSettingsPatch } from './app-settings.ts';
import type { CommandPayload, CommandResult, HostEvent, RendererHostCommand } from './host-protocol.ts';
import type { AccountsDto } from './dto.ts';

export type IpcResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: AppErrorData };

export type Unsubscribe = () => void;

export type AppView = 'main' | 'tray';

export const IPC = {
  host: {
    request: 'host:request',
    event: 'host:event',
    status: 'host:status',
    getStatus: 'host:get-status',
    restart: 'host:restart'
  },
  app: {
    getInfo: 'app:get-info',
    quit: 'app:quit'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    changed: 'settings:changed'
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    maximizedChanged: 'window:maximized-changed',
    showMain: 'window:show-main'
  },
  tray: {
    hide: 'tray:hide',
    setHeight: 'tray:set-height',
    shown: 'tray:shown',
    clipboardSuggestion: 'tray:clipboard-suggestion',
    dismissSuggestion: 'tray:dismiss-suggestion'
  },
  dialogs: {
    chooseDownloadDir: 'dialogs:choose-download-dir'
  },
  shell: {
    openExternal: 'shell:open-external',
    openFile: 'shell:open-file',
    revealFile: 'shell:reveal-file'
  },
  media: {
    preview: 'media:preview',
    thumbnail: 'media:thumbnail'
  },
  clipboard: {
    readUrls: 'clipboard:read-urls'
  },
  accounts: {
    connect: 'accounts:connect',
    disconnect: 'accounts:disconnect',
    saveApiKey: 'accounts:save-api-key',
    connectPixiv: 'accounts:connect-pixiv',
    disconnectPixiv: 'accounts:disconnect-pixiv'
  },
  vault: {
    reset: 'vault:reset'
  },
  updates: {
    getStatus: 'updates:get-status',
    check: 'updates:check',
    install: 'updates:install',
    status: 'updates:status'
  }
} as const;

/* ─────────────────────────── Payload schemas (validated in main) ─────────────────────────── */

export const IpcSchemas = {
  hostRequest: v.object({ command: v.string({ min: 1, max: 64 }), payload: v.unknown() }),
  trayHeight: v.object({ height: v.number({ int: true, min: 80, max: 720 }) }),
  openExternal: v.object({ url: v.httpUrl() }),
  filePath: v.object({ path: v.fsPath() }),
  thumbnail: v.object({ path: v.fsPath(), size: v.enum(['small', 'large'] as const) }),
  dismissSuggestion: v.object({ url: v.httpUrl() }),
  /** `vault:reset` takes no argument. */
  resetVault: v.empty(),

  oauthSiteRef: v.object({ siteId: v.string({ min: 1, max: 64 }) }),
  saveApiKey: v.object({
    siteId: v.string({ min: 1, max: 64 }),
    credentials: v.string({ min: 1, max: 8_192 })
  })
} as const;

/* ─────────────────────────── DTOs owned by main ─────────────────────────── */

export type HostConnectionStatus =
  | { readonly state: 'starting' }
  | { readonly state: 'ready' }
  | { readonly state: 'restarting'; readonly attempt: number; readonly error: AppErrorData | null }
  | { readonly state: 'offline'; readonly error: AppErrorData | null };

export interface AppInfo {
  readonly version: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly isPackaged: boolean;
  readonly view: AppView;
  readonly paths: { readonly data: string; readonly logs: string };
  /** Whether secrets are protected by the OS keychain/DPAPI (false = weaker fallback). */
  readonly secretsProtected: boolean;
}

export interface MediaUrlDto {
  /** `yami-media://…` URL valid for a limited time (see `MEDIA_URL_LIMITS`). */
  readonly url: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly name: string;
}

/** URLs each window's renderer keeps cached (LRU). */
const MEDIA_URL_CACHE_ENTRIES = 400;

/**
 * Lifetimes of `MediaUrlDto` URLs, derived from one place so renderer and main stay consistent: each window
 * caches at most `cacheEntries` URLs for `cacheTtlMs`, while main keeps the tokens behind them (reusing the live
 * token of an unchanged file) in a table several windows' caches larger that outlives any cached copy. A cached URL
 * that still fails to load is dropped and refetched once by the renderer.
 *
 * Tokens slide (`tokenTtlMs` after the last use, so a long video never stops) but never outlive `tokenMaxAgeMs`
 * from their issue: a leaked URL stays usable for a bounded time. Six hours covers a feature film or a long stream
 * VOD watched in one go; a video still playing when its token dies is refetched and resumed by the renderer.
 */
export const MEDIA_URL_LIMITS = {
  cacheEntries: MEDIA_URL_CACHE_ENTRIES,
  cacheTtlMs: 20 * 60_000,
  tokenEntries: MEDIA_URL_CACHE_ENTRIES * 4,
  tokenTtlMs: 30 * 60_000,
  tokenMaxAgeMs: 6 * 60 * 60_000
} as const;

export interface OpenFileResult {
  /** `opened`, `revealed` (blocked type shown in folder instead) or `declined` by the user. */
  readonly action: 'opened' | 'revealed' | 'declined';
}

export type UpdateStatus =
  | { readonly state: 'disabled'; readonly reason: 'dev' | 'portable' | 'setting' | 'unsupported' }
  | { readonly state: 'idle'; readonly checkedAt: number | null }
  | { readonly state: 'checking' }
  | { readonly state: 'available'; readonly version: string }
  | { readonly state: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly state: 'ready'; readonly version: string }
  | { readonly state: 'error'; readonly error: AppErrorData }
  /**
   * A build that cannot install updates (portable): main only checks and never downloads or installs.
   * `version` is the newer release the last check found (`null`: up to date or not checked yet); the user
   * downloads it from `RELEASES_URL`. `error` is the last check's failure.
   */
  | {
      readonly state: 'manual';
      readonly version: string | null;
      readonly checkedAt: number | null;
      readonly checking: boolean;
      readonly error: AppErrorData | null;
    };

/** Where new versions are downloaded by hand (builds in the `manual` update state). */
export const RELEASES_URL = 'https://github.com/rafaelnassar/Yami/releases/latest';

/**
 * Outcome of `vault.reset`: `reset` — the unreadable vault was moved aside and a new,
 * empty one is in use; `reset-pending` — same, but the restarted host is still starting
 * (its state reports the working vault once it is up); `recovered` — the vault works (the
 * key could be loaded again), nothing was reset; `cancelled` — the user declined.
 */
export interface VaultResetResult {
  readonly outcome: 'reset' | 'reset-pending' | 'recovered' | 'cancelled';
}

export interface ClipboardSuggestionDto {
  readonly url: string;
  readonly siteHost: string;
}

/* ─────────────────────────── The API exposed on window.yami ─────────────────────────── */

export interface YamiApi {
  readonly view: AppView;
  readonly platform: 'win32' | 'darwin' | 'linux';

  readonly host: {
    request<C extends RendererHostCommand>(
      command: C,
      payload: CommandPayload<C>
    ): Promise<IpcResult<CommandResult<C>>>;
    onEvent(listener: (event: HostEvent) => void): Unsubscribe;
    getStatus(): Promise<HostConnectionStatus>;
    onStatus(listener: (status: HostConnectionStatus) => void): Unsubscribe;
    restart(): Promise<IpcResult<null>>;
  };

  readonly app: {
    getInfo(): Promise<AppInfo>;
    quit(): void;
  };

  readonly settings: {
    get(): Promise<AppSettings>;
    update(patch: AppSettingsPatch): Promise<IpcResult<AppSettings>>;
    onChanged(listener: (settings: AppSettings) => void): Unsubscribe;
  };

  readonly window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChange(listener: (maximized: boolean) => void): Unsubscribe;
    showMain(): void;
  };

  readonly tray: {
    hide(): void;
    setHeight(height: number): void;
    onShown(listener: () => void): Unsubscribe;
    onClipboardSuggestion(listener: (suggestion: ClipboardSuggestionDto | null) => void): Unsubscribe;
    dismissSuggestion(url: string): void;
  };

  readonly dialogs: {
    /** Native folder picker; the chosen folder is validated and applied by main + host. */
    chooseDownloadDir(): Promise<IpcResult<{ readonly downloadDir: string } | null>>;
  };

  readonly shell: {
    openExternal(url: string): Promise<IpcResult<null>>;
    /** Opens with the OS handler after host path validation and the risk policy. */
    openFile(path: string): Promise<IpcResult<OpenFileResult>>;
    revealFile(path: string): Promise<IpcResult<null>>;
  };

  readonly media: {
    preview(path: string): Promise<IpcResult<MediaUrlDto>>;
    thumbnail(path: string, size: 'small' | 'large'): Promise<IpcResult<MediaUrlDto>>;
  };

  readonly clipboard: {
    /** http(s) URLs currently in the clipboard (user-initiated paste). */
    readUrls(): Promise<readonly string[]>;
  };

  readonly accounts: {
    connect(siteId: string): Promise<IpcResult<AccountsDto>>;
    disconnect(siteId: string): Promise<IpcResult<AccountsDto>>;
    /** Paste Gelbooru-style `&api_key=…&user_id=…` for API-key sites. */
    saveApiKey(siteId: string, credentials: string): Promise<IpcResult<AccountsDto>>;
    connectPixiv(): Promise<IpcResult<AccountsDto>>;
    disconnectPixiv(): Promise<IpcResult<AccountsDto>>;
  };

  readonly vault: {
    /**
     * Recovery from a disabled vault (`HostConfigDto.vault`): after a native confirmation,
     * main moves the unreadable vault aside (never deletes it), creates a new key and
     * restarts the host. Stored cookie files and the Pixiv login are lost.
     */
    reset(): Promise<IpcResult<VaultResetResult>>;
  };

  readonly updates: {
    getStatus(): Promise<UpdateStatus>;
    check(): Promise<IpcResult<UpdateStatus>>;
    install(): Promise<IpcResult<null>>;
    onStatus(listener: (status: UpdateStatus) => void): Unsubscribe;
  };
}
