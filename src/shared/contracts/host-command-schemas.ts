/**
 * Part of the host protocol (main ↔ download host utility process).
 * See `host-protocol.ts` for the transport overview.
 */
import { v } from '../validation/schema.ts';
import { DOWNLOAD_SCOPES, ENGINES, RUNTIME_MODES, TOOL_IDS } from '../domain/engine.ts';
import { VAULT_UNAVAILABLE_REASONS } from './dto.ts';

/* ─────────────────────────── Limits ─────────────────────────── */

export const LIMITS = {
  maxUrlsPerBatch: 500,
  maxCookieFileBytes: 5 * 1024 * 1024,
  maxTitleLength: 120,
  maxFolderNameLength: 80,
  maxPathsPerDelete: 5_000,
  maxPageSize: 1_000,
  maxCookieBindings: 200
} as const;

/* ─────────────────────────── Payload schemas ─────────────────────────── */

const engine = v.enum(ENGINES);
const scope = v.enum(DOWNLOAD_SCOPES);
const runtimeMode = v.enum(RUNTIME_MODES);
const toolId = v.enum(TOOL_IDS);
const conversationRef = v.object({ conversationId: v.id() });
const cursor = v.optional(v.string({ min: 1, max: 512 }));
const cookieName = v.string({ min: 1, max: 128, pattern: /^[\w.@()+ -]+\.txt$/ });
const color = v.string({ pattern: /^#[0-9A-Fa-f]{6}$/ });
const folderName = v.string({ min: 1, max: LIMITS.maxFolderNameLength, trim: true });

export const Schemas = {
  empty: v.empty(),

  start: v.object({
    urls: v.array(v.httpUrl(), { min: 1, max: LIMITS.maxUrlsPerBatch }),
    engine,
    scope,
    /** Cookie file chosen per URL (same length as `urls`), `null` = automatic resolution. */
    cookieNames: v.optional(v.array(v.nullable(cookieName), { max: LIMITS.maxUrlsPerBatch })),
    /** Sidebar folder that should receive the new conversations. */
    folderId: v.optional(v.nullable(v.id()))
  }),

  conversationRef,

  listConversations: v.object({
    limit: v.optional(v.number({ int: true, min: 1, max: LIMITS.maxPageSize })),
    cursor
  }),

  conversationFiles: v.object({
    conversationId: v.id(),
    limit: v.optional(v.number({ int: true, min: 1, max: LIMITS.maxPageSize })),
    cursor
  }),

  renameConversation: v.object({
    conversationId: v.id(),
    title: v.string({ min: 1, max: LIMITS.maxTitleLength, trim: true })
  }),

  deleteConversation: v.object({ conversationId: v.id(), deleteFiles: v.boolean() }),

  moveToFolder: v.object({
    conversationIds: v.array(v.id(), { min: 1, max: 5_000 }),
    folderId: v.nullable(v.id())
  }),

  createFolder: v.object({ name: folderName, color }),

  updateFolder: v.object({
    folderId: v.id(),
    name: v.optional(folderName),
    color: v.optional(color),
    collapsed: v.optional(v.boolean()),
    position: v.optional(v.number({ int: true, min: 0, max: 100_000 }))
  }),

  folderRef: v.object({ folderId: v.id() }),

  deleteFiles: v.object({ paths: v.array(v.fsPath(), { min: 1, max: LIMITS.maxPathsPerDelete }) }),

  inspectFile: v.object({ path: v.fsPath() }),

  uploadCookies: v.object({
    name: cookieName,
    content: v.string({ min: 1, max: LIMITS.maxCookieFileBytes, noControlChars: false })
  }),

  selectCookies: v.object({ name: v.nullable(cookieName) }),

  cookieRef: v.object({ name: cookieName }),

  setCookieBindings: v.object({
    bindings: v.array(
      v.object({
        id: v.id(),
        siteHost: v.string({ min: 1, max: 253, trim: true, pattern: /^[a-z0-9.-]+$/i }),
        cookieName
      }),
      { max: LIMITS.maxCookieBindings }
    )
  }),

  setFromBrowser: v.object({ enabled: v.boolean() }),

  setDefaultEngine: v.object({ engine }),

  setRuntimeMode: v.object({ mode: runtimeMode }),

  installRuntime: v.object({ mode: runtimeMode }),

  updateRuntime: v.object({ tools: v.optional(v.array(toolId, { min: 1, max: TOOL_IDS.length })) }),

  /* main-only */

  configure: v.object({
    paths: v.object({
      dataDir: v.fsPath(),
      runtimeDir: v.fsPath(),
      logsDir: v.fsPath(),
      tempDir: v.fsPath(),
      /** Legacy `~/.yami` directory to import once, when present. */
      legacyDir: v.nullable(v.fsPath()),
      /** Resources/app directories that must never be used as download dir. */
      protectedDirs: v.array(v.fsPath(), { max: 20 })
    }),
    /**
     * 32-byte data key (base64) for the secret vault; held in memory only. `null`: main
     * could not load it and the host starts with a disabled vault (`VaultStatusDto`).
     */
    vaultKey: v.nullable(v.string({ min: 40, max: 64, pattern: /^[A-Za-z0-9+/=]+$/ })),
    /** Why `vaultKey` is `null` (shown to the user); ignored when a key is sent. */
    vaultUnavailable: v.optional(v.enum(VAULT_UNAVAILABLE_REASONS)),
    defaultDownloadDir: v.fsPath(),
    isPackaged: v.boolean(),
    appVersion: v.string({ min: 1, max: 64 })
  }),

  setDownloadDir: v.object({ path: v.fsPath() }),

  savePixivAccount: v.object({
    refreshToken: v.string({ min: 10, max: 4_096 }),
    userName: v.nullable(v.string({ max: 256 })),
    userId: v.nullable(v.string({ max: 64 }))
  }),

  siteRef: v.object({ siteId: v.string({ min: 1, max: 64 }) }),

  saveSiteAccount: v.object({
    siteId: v.string({ min: 1, max: 64 }),
    kind: v.enum(['refresh-token', 'access-token', 'oauth1', 'api-key'] as const),
    refreshToken: v.optional(v.string({ min: 10, max: 4_096 })),
    accessToken: v.optional(v.string({ min: 10, max: 4_096 })),
    accessTokenSecret: v.optional(v.string({ min: 10, max: 4_096 })),
    apiKey: v.optional(v.string({ min: 10, max: 4_096 })),
    userName: v.nullable(v.string({ max: 256 })),
    userId: v.nullable(v.string({ max: 64 }))
  }),

  downloadHistory: v.object({ limit: v.number({ int: true, min: 1, max: 2_000 }) }),

  /** One-time import of data the legacy renderer kept in localStorage (folders, bindings). */
  importLegacyUiData: v.object({
    folders: v.array(
      v.object({
        id: v.id(),
        name: v.string({ min: 1, max: 200, trim: true }),
        color: v.string({ max: 16 }),
        createdAt: v.number({ int: true, min: 0 }),
        collapsed: v.boolean()
      }),
      { max: 1_000 }
    ),
    folderMap: v.record(v.id(), { maxKeys: 100_000, key: v.id() }),
    cookieBindings: v.array(
      v.object({
        id: v.id(),
        siteHost: v.string({ min: 1, max: 253, trim: true }),
        cookieName: v.string({ min: 1, max: 128 })
      }),
      { max: LIMITS.maxCookieBindings }
    )
  }),

  shutdown: v.object({
    /** `pause`: running downloads are stopped and kept as paused (resumable). `detach`: leave engines running. */
    mode: v.enum(['pause', 'detach'] as const)
  })
} as const;
