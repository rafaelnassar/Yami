/**
 * Wires the application layer (downloads core, runtime tools, use cases) on top
 * of the infrastructure adapters and produces the `HostServices` table.
 */
import process from 'node:process';
import { systemClock } from '../../shared/kernel/clock.ts';
import type { EventSink } from '../application/ports/system.ts';
import { DownloadCoordinator } from '../application/downloads/download-coordinator.ts';
import type { NoticeCenter } from '../application/session/notice-center.ts';
import type { RecentLogs } from '../application/session/recent-logs.ts';
import { StateProjector } from '../application/session/state-projector.ts';
import { StatePublisher } from '../application/session/state-publisher.ts';
import { SessionService } from '../application/session/session-service.ts';
import { NoticesService } from '../application/session/notices-service.ts';
import { DownloadHistoryService } from '../application/session/download-history.ts';
import type { SettingsStore } from '../application/settings/settings-store.ts';
import { SetDefaultEngineService } from '../application/settings/set-default-engine.ts';
import { SetDownloadDirService } from '../application/settings/set-download-dir.ts';
import type { AccountsStatus } from '../application/accounts/accounts-status.ts';
import { PixivAccountService } from '../application/accounts/pixiv-account-service.ts';
import { SiteAccountService } from '../application/accounts/site-account-service.ts';
import { ConversationQueryService } from '../application/conversations/conversation-query-service.ts';
import { RenameConversationService } from '../application/conversations/rename-conversation.ts';
import { DeleteConversationService } from '../application/conversations/delete-conversation.ts';
import { MoveToFolderService } from '../application/conversations/move-to-folder.ts';
import { FolderService } from '../application/folders/folder-service.ts';
import { SandboxedFileRemover } from '../application/library/sandboxed-file-remover.ts';
import { DeleteFilesService } from '../application/library/delete-files.ts';
import { InspectFileService } from '../application/library/inspect-file.ts';
import { CookiesSnapshotBuilder } from '../application/cookies/cookies-snapshot.ts';
import { CookieFilesService } from '../application/cookies/cookie-files-service.ts';
import { CookiePreferencesService } from '../application/cookies/cookie-preferences-service.ts';
import { LegacyUiImportService } from '../application/legacy/import-legacy-ui-data.ts';
import { RuntimeToolsService } from '../application/runtime/runtime-service.ts';
import { createEngineRegistry } from '../infrastructure/engines/engine-registry.ts';
import { createRuntimeAdapters } from '../infrastructure/runtime/create-runtime-adapters.ts';
import type { HostServices } from '../interface/handler-table.ts';
import type { HostInfrastructure } from './infrastructure.ts';

export interface WiredServices {
  readonly runtime: RuntimeToolsService;
  readonly coordinator: DownloadCoordinator;
  readonly services: HostServices;
  readonly statePublisher: StatePublisher;
}

export interface ServiceWiringInput {
  readonly infra: HostInfrastructure;
  /** Head of the sink chain (RecentLogs → NoticeCenter → dispatcher). */
  readonly events: RecentLogs & EventSink;
  readonly notices: NoticeCenter;
  readonly accounts: AccountsStatus;
  readonly settings: SettingsStore;
}

function createRuntime({ infra, events }: ServiceWiringInput): RuntimeToolsService {
  const { config, platform, homeDir, logger, persistence, workspace } = infra;
  const adapters = createRuntimeAdapters({
    runtimeDir: config.paths.runtimeDir,
    platform,
    arch: process.arch,
    isPackaged: config.isPackaged,
    appVersion: config.appVersion,
    env: process.env,
    homeDir,
    logger,
    processCwd: workspace.processCwd
  });
  return new RuntimeToolsService({
    ...adapters,
    isPackaged: config.isPackaged,
    settings: persistence.context.settings,
    events,
    logger
  });
}

export function wireServices(input: ServiceWiringInput): WiredServices {
  const { infra, events, notices, accounts, settings } = input;
  const store = infra.persistence.context;
  const runtime = createRuntime(input);
  // gallery-dl may hand Fanbox/Facebook videos to yt-dlp only when yt-dlp is installed.
  const engines = createEngineRegistry({
    galleryDl: { delegateVideosToYtdl: () => runtime.resolveEngine('yt-dlp') !== null }
  });

  const coordinator = new DownloadCoordinator({
    persistence: store,
    engines,
    tools: runtime,
    engineEnvironment: infra.engineEnvironment,
    launcher: infra.launcher,
    inspector: infra.inspector,
    terminator: infra.terminator,
    logReaders: infra.logReaders,
    workspace: infra.workspace,
    cookieVault: infra.cookieVault,
    credentialVault: infra.credentialVault,
    browserCookies: infra.browserCookies,
    sandbox: infra.sandbox,
    events,
    logger: infra.logger,
    clock: systemClock,
    fileSystem: infra.fileSystem,
    fileMarker: infra.fileMarker,
    // Never launch an engine while its binary/environment may be replaced.
    runtimeBusy: () => runtime.isBusy(),
    options: { sensitiveDirs: infra.sensitiveDirs, platform: infra.platform }
  });
  runtime.setDownloadsActiveProbe(() => coordinator.hasActive());

  const projector = new StateProjector({
    downloads: coordinator,
    runtime,
    settings,
    accounts,
    sandbox: infra.sandbox,
    notices,
    vault: infra.vault
  });
  const publisher = new StatePublisher(projector, events);
  coordinator.onChange(() => publisher.stateChanged());
  runtime.onChange(() => {
    publisher.stateChanged();
    coordinator.reschedule();
  });

  const snapshots = new CookiesSnapshotBuilder(infra.cookieVault, settings, events);
  const remover = new SandboxedFileRemover(infra.sandbox, infra.fileSystem);
  const cookieDeps = {
    vault: infra.cookieVault,
    settings,
    snapshots,
    state: publisher,
    vaultReady: () => infra.vault.state === 'ready'
  };

  const services: HostServices = {
    downloads: coordinator,
    runtime,
    projectState: () => projector.project(),
    session: new SessionService(projector, accounts),
    notices: new NoticesService(notices, publisher),
    logs: events,
    history: new DownloadHistoryService(store.downloads),
    conversations: new ConversationQueryService(store.conversations, store.files),
    renameConversation: new RenameConversationService(store.downloads, events, systemClock),
    deleteConversation: new DeleteConversationService({
      downloads: coordinator,
      records: store.downloads,
      files: store.files,
      events: store.events,
      tx: store.tx,
      remover,
      scanner: infra.scanner,
      sink: events
    }),
    moveToFolder: new MoveToFolderService(store.folders, events),
    folders: new FolderService({ folders: store.folders, tx: store.tx, events, clock: systemClock }),
    deleteFiles: new DeleteFilesService({ remover, files: store.files, scanner: infra.scanner, events }),
    inspectFile: new InspectFileService(infra.sandbox, infra.fileSystem),
    cookieFiles: new CookieFilesService(cookieDeps),
    cookiePreferences: new CookiePreferencesService(cookieDeps),
    setDefaultEngine: new SetDefaultEngineService(settings, publisher),
    setDownloadDir: new SetDownloadDirService({
      sandbox: infra.sandbox,
      settings,
      scanner: infra.scanner,
      events,
      state: publisher
    }),
    pixiv: new PixivAccountService(infra.credentialVault, accounts, publisher, systemClock),
    siteAccounts: new SiteAccountService(infra.credentialVault, accounts, publisher, systemClock),
    legacyUi: new LegacyUiImportService({
      folders: store.folders,
      records: store.downloads,
      vault: infra.cookieVault,
      settings,
      tx: store.tx,
      events,
      snapshots
    })
  };
  return { runtime, coordinator, services, statePublisher: publisher };
}
