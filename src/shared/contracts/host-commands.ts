/**
 * Part of the host protocol (main ↔ download host utility process).
 * See `host-protocol.ts` for the transport overview.
 */
import type { AppErrorData } from '../kernel/errors.ts';
import type { Schema } from '../validation/schema.ts';
import type {
  AccountsDto,
  ConversationDetailDto,
  ConversationSummaryDto,
  CookieBindingDto,
  CookieFileDto,
  FileInspectionDto,
  FolderDto,
  HostStateDto,
  LogEntryDto,
  MediaFileDto,
  Page
} from './dto.ts';
import type { Schemas } from './host-command-schemas.ts';

/* ─────────────────────────── Command table ─────────────────────────── */

type P<S> = S extends Schema<infer T> ? T : never;

export interface StartResult {
  readonly batchId: string;
  readonly conversationIds: readonly string[];
}

export interface DeleteFilesResult {
  readonly deleted: readonly string[];
  readonly failed: ReadonlyArray<{ readonly path: string; readonly error: AppErrorData }>;
}

export interface CookiesSnapshot {
  readonly files: readonly CookieFileDto[];
  readonly active: string | null;
  readonly bindings: readonly CookieBindingDto[];
  readonly fromBrowser: boolean;
}

export interface RuntimeOperationStarted {
  readonly operationId: string;
}

/** Maps command name → [payload, response]. */
export interface HostCommands {
  /* Session */
  'session.init': [P<typeof Schemas.empty>, { readonly state: HostStateDto }];

  /* Downloads */
  'downloads.start': [P<typeof Schemas.start>, StartResult];
  'downloads.pause': [P<typeof Schemas.conversationRef>, { readonly conversationId: string }];
  'downloads.resume': [P<typeof Schemas.conversationRef>, { readonly conversationId: string }];
  'downloads.stop': [P<typeof Schemas.conversationRef>, { readonly conversationId: string }];
  'downloads.restart': [P<typeof Schemas.conversationRef>, { readonly conversationId: string }];
  'downloads.pauseAll': [P<typeof Schemas.empty>, { readonly affected: number }];
  'downloads.resumeAll': [P<typeof Schemas.empty>, { readonly affected: number }];
  'downloads.stopAll': [P<typeof Schemas.empty>, { readonly affected: number }];

  /* Conversations */
  'conversations.list': [P<typeof Schemas.listConversations>, Page<ConversationSummaryDto>];
  'conversations.get': [P<typeof Schemas.conversationRef>, { readonly conversation: ConversationDetailDto }];
  'conversations.files': [P<typeof Schemas.conversationFiles>, Page<MediaFileDto>];
  'conversations.rename': [
    P<typeof Schemas.renameConversation>,
    { readonly conversationId: string; readonly title: string }
  ];
  'conversations.delete': [
    P<typeof Schemas.deleteConversation>,
    {
      readonly conversationId: string;
      readonly filesDeleted: number;
      readonly filesFailed: number;
      /** Files left on disk because another conversation still lists them (re-downloads). */
      readonly filesKept: number;
    }
  ];
  'conversations.moveToFolder': [P<typeof Schemas.moveToFolder>, { readonly moved: number }];

  /* Folders */
  'folders.list': [P<typeof Schemas.empty>, { readonly folders: readonly FolderDto[] }];
  'folders.create': [P<typeof Schemas.createFolder>, { readonly folder: FolderDto }];
  'folders.update': [P<typeof Schemas.updateFolder>, { readonly folder: FolderDto }];
  'folders.delete': [P<typeof Schemas.folderRef>, { readonly folderId: string }];

  /* Files */
  'files.delete': [P<typeof Schemas.deleteFiles>, DeleteFilesResult];
  'files.inspect': [P<typeof Schemas.inspectFile>, FileInspectionDto];

  /* Cookies */
  'cookies.list': [P<typeof Schemas.empty>, CookiesSnapshot];
  'cookies.upload': [P<typeof Schemas.uploadCookies>, CookiesSnapshot];
  'cookies.select': [P<typeof Schemas.selectCookies>, CookiesSnapshot];
  'cookies.delete': [P<typeof Schemas.cookieRef>, CookiesSnapshot];
  'cookies.setBindings': [P<typeof Schemas.setCookieBindings>, CookiesSnapshot];
  'cookies.setFromBrowser': [P<typeof Schemas.setFromBrowser>, CookiesSnapshot];

  /* Settings */
  'settings.setDefaultEngine': [P<typeof Schemas.setDefaultEngine>, { readonly engine: string }];

  /* Runtime tools (long operations run in background and report through events) */
  'runtime.setMode': [P<typeof Schemas.setRuntimeMode>, { readonly state: HostStateDto }];
  'runtime.dismissSetup': [P<typeof Schemas.empty>, { readonly state: HostStateDto }];
  'runtime.install': [P<typeof Schemas.installRuntime>, RuntimeOperationStarted];
  'runtime.update': [P<typeof Schemas.updateRuntime>, RuntimeOperationStarted];
  'runtime.checkUpdates': [P<typeof Schemas.empty>, RuntimeOperationStarted];

  /* Notices & logs */
  'notices.clearError': [P<typeof Schemas.empty>, Record<string, never>];
  'logs.recent': [P<typeof Schemas.empty>, { readonly entries: readonly LogEntryDto[] }];

  /* ── main-only ── */
  'system.configure': [P<typeof Schemas.configure>, { readonly state: HostStateDto }];
  'settings.setDownloadDir': [P<typeof Schemas.setDownloadDir>, { readonly downloadDir: string }];
  'accounts.pixiv.save': [P<typeof Schemas.savePixivAccount>, { readonly accounts: AccountsDto }];
  'accounts.pixiv.clear': [P<typeof Schemas.empty>, { readonly accounts: AccountsDto }];
  'accounts.site.save': [P<typeof Schemas.saveSiteAccount>, { readonly accounts: AccountsDto }];
  'accounts.site.clear': [P<typeof Schemas.siteRef>, { readonly accounts: AccountsDto }];
  'downloads.history': [P<typeof Schemas.downloadHistory>, { readonly sourceUrls: readonly string[] }];
  'legacy.importUiData': [
    P<typeof Schemas.importLegacyUiData>,
    { readonly folders: number; readonly assignments: number; readonly bindings: number }
  ];
  'lifecycle.shutdown': [P<typeof Schemas.shutdown>, Record<string, never>];
}

export type HostCommand = keyof HostCommands;
export type CommandPayload<C extends HostCommand> = HostCommands[C][0];
export type CommandResult<C extends HostCommand> = HostCommands[C][1];

export type CommandAudience = 'renderer' | 'main';

/** Privileged commands: only the main process may send them (never forwarded from a window). */
export const MAIN_ONLY_COMMANDS = [
  'system.configure',
  'settings.setDownloadDir',
  'accounts.pixiv.save',
  'accounts.pixiv.clear',
  'accounts.site.save',
  'accounts.site.clear',
  'downloads.history',
  'legacy.importUiData',
  'lifecycle.shutdown'
] as const satisfies readonly HostCommand[];

export type MainOnlyCommand = (typeof MAIN_ONLY_COMMANDS)[number];

/** Commands a renderer window may invoke (after main validates sender + payload). */
export type RendererHostCommand = Exclude<HostCommand, MainOnlyCommand>;
