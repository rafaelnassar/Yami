/**
 * Maps every protocol command to its application use case. `system.configure` and
 * `lifecycle.shutdown` are process-lifecycle commands handled by the bootstrap and
 * are passed in as ready-made handlers.
 */
import { ok } from '../../shared/kernel/result.ts';
import type { HostStateDto } from '../../shared/contracts/dto.ts';
import type { DownloadsFacade } from '../application/downloads/downloads-facade.ts';
import type { RuntimeService } from '../application/ports/runtime.ts';
import type { SessionService } from '../application/session/session-service.ts';
import type { NoticesService } from '../application/session/notices-service.ts';
import type { RecentLogs } from '../application/session/recent-logs.ts';
import type { DownloadHistoryService } from '../application/session/download-history.ts';
import type { ConversationQueryService } from '../application/conversations/conversation-query-service.ts';
import type { RenameConversationService } from '../application/conversations/rename-conversation.ts';
import type { DeleteConversationService } from '../application/conversations/delete-conversation.ts';
import type { MoveToFolderService } from '../application/conversations/move-to-folder.ts';
import type { FolderService } from '../application/folders/folder-service.ts';
import type { DeleteFilesService } from '../application/library/delete-files.ts';
import type { InspectFileService } from '../application/library/inspect-file.ts';
import type { CookieFilesService } from '../application/cookies/cookie-files-service.ts';
import type { CookiePreferencesService } from '../application/cookies/cookie-preferences-service.ts';
import type { SetDefaultEngineService } from '../application/settings/set-default-engine.ts';
import type { SetDownloadDirService } from '../application/settings/set-download-dir.ts';
import type { PixivAccountService } from '../application/accounts/pixiv-account-service.ts';
import type { SiteAccountService } from '../application/accounts/site-account-service.ts';
import type { LegacyUiImportService } from '../application/legacy/import-legacy-ui-data.ts';
import type { CommandHandler, CommandHandlers } from './command-router.ts';

export interface HostServices {
  readonly downloads: DownloadsFacade;
  readonly runtime: RuntimeService;
  readonly projectState: () => HostStateDto;
  readonly session: SessionService;
  readonly notices: NoticesService;
  readonly logs: RecentLogs;
  readonly history: DownloadHistoryService;
  readonly conversations: ConversationQueryService;
  readonly renameConversation: RenameConversationService;
  readonly deleteConversation: DeleteConversationService;
  readonly moveToFolder: MoveToFolderService;
  readonly folders: FolderService;
  readonly deleteFiles: DeleteFilesService;
  readonly inspectFile: InspectFileService;
  readonly cookieFiles: CookieFilesService;
  readonly cookiePreferences: CookiePreferencesService;
  readonly setDefaultEngine: SetDefaultEngineService;
  readonly setDownloadDir: SetDownloadDirService;
  readonly pixiv: PixivAccountService;
  readonly siteAccounts: SiteAccountService;
  readonly legacyUi: LegacyUiImportService;
}

export interface LifecycleHandlers {
  readonly configure: CommandHandler<'system.configure'>;
  readonly shutdown: CommandHandler<'lifecycle.shutdown'>;
}

export function createHandlerTable(s: HostServices, lifecycle: LifecycleHandlers): CommandHandlers {
  const stateResult = () => ok({ state: s.projectState() });
  return {
    'session.init': () => s.session.init(),

    'downloads.start': (p) =>
      s.downloads.start({
        urls: p.urls,
        engine: p.engine,
        scope: p.scope,
        cookieNames: p.cookieNames ?? null,
        folderId: p.folderId ?? null
      }),
    'downloads.pause': (p) => s.downloads.pause(p.conversationId),
    'downloads.resume': (p) => s.downloads.resume(p.conversationId),
    'downloads.stop': (p) => s.downloads.stop(p.conversationId),
    'downloads.restart': (p) => s.downloads.restart(p.conversationId),
    'downloads.pauseAll': async () => ok(await s.downloads.pauseAll()),
    'downloads.resumeAll': async () => ok(await s.downloads.resumeAll()),
    'downloads.stopAll': async () => ok(await s.downloads.stopAll()),

    'conversations.list': (p) => s.conversations.list(p),
    'conversations.get': (p) => s.conversations.get(p),
    'conversations.files': (p) => s.conversations.files(p),
    'conversations.rename': (p) => s.renameConversation.rename(p),
    'conversations.delete': (p) => s.deleteConversation.delete(p),
    'conversations.moveToFolder': (p) => s.moveToFolder.moveToFolder(p),

    'folders.list': () => s.folders.list(),
    'folders.create': (p) => s.folders.create(p),
    'folders.update': (p) => s.folders.update(p),
    'folders.delete': (p) => s.folders.delete(p),

    'files.delete': (p) => s.deleteFiles.delete(p),
    'files.inspect': (p) => s.inspectFile.inspect(p),

    'cookies.list': () => s.cookieFiles.list(),
    'cookies.upload': (p) => s.cookieFiles.upload(p),
    'cookies.delete': (p) => s.cookieFiles.delete(p),
    'cookies.select': (p) => s.cookiePreferences.select(p),
    'cookies.setBindings': (p) => s.cookiePreferences.setBindings(p),
    'cookies.setFromBrowser': (p) => s.cookiePreferences.setFromBrowser(p),

    'settings.setDefaultEngine': (p) => s.setDefaultEngine.setDefaultEngine(p),

    'runtime.setMode': async (p) => {
      await s.runtime.setMode(p.mode);
      return stateResult();
    },
    'runtime.dismissSetup': () => {
      s.runtime.dismissSetup();
      return stateResult();
    },
    'runtime.install': (p) => s.runtime.startInstall(p.mode),
    'runtime.update': (p) => s.runtime.startUpdate(p.tools ?? null),
    'runtime.checkUpdates': () => s.runtime.startCheckUpdates(),

    'notices.clearError': () => s.notices.clearError(),
    'logs.recent': () => s.logs.recent(),

    'system.configure': lifecycle.configure,
    'settings.setDownloadDir': (p) => s.setDownloadDir.setDownloadDir(p),
    'accounts.pixiv.save': (p) => s.pixiv.save(p),
    'accounts.pixiv.clear': () => s.pixiv.clear(),
    'accounts.site.save': (p) => s.siteAccounts.save(p),
    'accounts.site.clear': (p) => s.siteAccounts.clear(p),
    'downloads.history': (p) => s.history.history(p),
    'legacy.importUiData': (p) => s.legacyUi.importUiData(p),
    'lifecycle.shutdown': lifecycle.shutdown
  };
}
