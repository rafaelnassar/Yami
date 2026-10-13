/**
 * Download use cases for the UI: start, lifecycle commands, rename, delete and
 * folder moves. Each command updates the relevant stores and reports feedback
 * through toasts (i18n keys, never literal text).
 */
import type { ConversationSummaryDto } from '../../../shared/contracts/dto.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { DownloadScope, Engine } from '../../../shared/domain/engine.ts';
import type { HostRequest } from '../../shared/api/yami-client.ts';
import type { MediaUrlCache } from '../../shared/lib/media-cache.ts';
import { errorText, key, type NoticesStore } from '../notices/notices-store.ts';
import type { PreviewStore } from '../preview/preview-store.ts';
import type { ActiveConversationStore } from './store/active-conversation-store.ts';
import type { ComposerStore } from './store/composer-store.ts';
import { isRestartableStatus } from './store/conversation-model.ts';
import type { ConversationsStore } from './store/conversations-store.ts';
import type { FoldersStore } from './store/folders-store.ts';

export interface DownloadActionsDeps {
  readonly request: HostRequest;
  readonly notices: NoticesStore;
  readonly conversations: ConversationsStore;
  readonly active: ActiveConversationStore;
  readonly composer: ComposerStore;
  readonly folders: FoldersStore;
  readonly preview: PreviewStore;
  readonly media: MediaUrlCache;
}

export type LifecycleCommand = 'downloads.pause' | 'downloads.resume' | 'downloads.stop' | 'downloads.restart';

export interface DownloadActions {
  readonly start: (urls: readonly string[], engine: Engine, scope: DownloadScope) => Promise<boolean>;
  readonly lifecycle: (command: LifecycleCommand, conversationId: string) => Promise<boolean>;
  readonly restartMany: (conversations: readonly ConversationSummaryDto[]) => Promise<void>;
  readonly rename: (conversationId: string, title: string) => Promise<boolean>;
  readonly deleteConversation: (conversationId: string, deleteFiles: boolean) => Promise<boolean>;
  readonly deleteFiles: (paths: readonly string[]) => Promise<boolean>;
  readonly moveToFolder: (conversationIds: readonly string[], folderId: string | null) => Promise<boolean>;
  readonly selectConversation: (conversationId: string) => void;
  readonly newDownload: (folderId?: string | null) => void;
}

const LIFECYCLE_TOASTS = {
  'downloads.pause': {
    kind: 'info',
    title: 'ui.session.toast.paused',
    message: 'ui.session.toast.pauseMsg',
    fail: 'ui.session.toast.pauseFail'
  },
  'downloads.resume': {
    kind: 'info',
    title: 'ui.session.toast.resumed',
    message: 'ui.session.toast.resumedMsg',
    fail: 'ui.session.toast.resumeFail'
  },
  'downloads.stop': {
    kind: 'success',
    title: 'ui.session.toast.stopped',
    message: 'ui.session.toast.stoppedMsg',
    fail: 'ui.session.toast.stopFail'
  },
  'downloads.restart': {
    kind: 'info',
    title: 'ui.session.toast.restarted',
    message: 'ui.session.toast.restartedMsg',
    fail: 'ui.session.toast.restartFail'
  }
} as const;

export function createDownloadActions(deps: DownloadActionsDeps): DownloadActions {
  const toast = deps.notices.getState();

  const expandFolder = (folderId: string | null): void => {
    if (!folderId) return;
    const folder = deps.folders.getState().folders.find((item) => item.id === folderId);
    if (!folder?.collapsed) return;
    void deps.folders
      .getState()
      .update(folderId, { collapsed: false })
      .then((error) => {
        if (error) toast.push({ kind: 'error', title: key('ui.folders.saveFail'), message: errorText(error) });
      });
  };

  const forgetPaths = (paths: readonly string[]): void => {
    if (paths.length === 0) return;
    deps.active.getState().removeFiles(paths);
    deps.preview.getState().removePaths(paths);
    deps.media.invalidate(paths);
  };

  return {
    async start(urls, engine, scope) {
      const composer = deps.composer.getState();
      const folderId = composer.pendingFolderId;
      composer.beginStart();
      const result = await deps.request('downloads.start', { urls: [...urls], engine, scope, folderId });
      deps.composer.getState().endStart(result.ok, scope);
      if (!result.ok) {
        toast.push({ kind: 'error', title: key('ui.session.toast.startFail'), message: errorText(result.error) });
        return false;
      }
      const first = result.data.conversationIds[0];
      if (first) deps.active.getState().open(first);
      expandFolder(folderId);
      void deps.conversations.getState().refresh();
      toast.push(
        urls.length > 1
          ? {
              kind: 'info',
              title: key('ui.session.toast.batchStarted'),
              message: key('ui.session.toast.batchStartedMsg', { count: urls.length, engine })
            }
          : {
              kind: 'info',
              title: key('ui.session.toast.downloadStarted'),
              message: key('ui.session.toast.downloadStartedMsg', { engine })
            }
      );
      return true;
    },

    async lifecycle(command, conversationId) {
      const copy = LIFECYCLE_TOASTS[command];
      const result = await deps.request(command, { conversationId });
      if (!result.ok) {
        toast.push({ kind: 'error', title: key(copy.fail), message: errorText(result.error) });
        return false;
      }
      deps.conversations.getState().scheduleRefresh();
      deps.active.getState().scheduleReload();
      toast.push({ kind: copy.kind, title: key(copy.title), message: key(copy.message) });
      return true;
    },

    async restartMany(conversations) {
      const targets = conversations.filter((item) => isRestartableStatus(item.status));
      if (targets.length === 0) {
        toast.push({
          kind: 'warn',
          title: key('ui.session.toast.nothingToRestart'),
          message: key('ui.session.toast.nothingToRestartMsg')
        });
        return;
      }
      let restarted = 0;
      let firstError: AppErrorData | null = null;
      for (const conversation of targets) {
        const result = await deps.request('downloads.restart', { conversationId: conversation.id });
        if (result.ok) restarted += 1;
        else firstError ??= result.error;
      }
      if (restarted > 0) deps.conversations.getState().scheduleRefresh();
      if (restarted === targets.length) {
        toast.push({
          kind: 'success',
          title: key('ui.session.toast.restartedMany', { count: restarted }),
          message: key('ui.session.toast.folderRestartedMsg')
        });
      } else if (restarted > 0) {
        toast.push({
          kind: 'warn',
          title: key('ui.session.toast.restartedPartial', { restarted, total: targets.length }),
          message: firstError ? errorText(firstError) : key('ui.session.toast.restartedPartialMsg')
        });
      } else {
        toast.push({
          kind: 'error',
          title: key('ui.session.toast.restartFail'),
          message: firstError ? errorText(firstError) : key('ui.session.toast.restartedNoneMsg')
        });
      }
    },

    async rename(conversationId, title) {
      const result = await deps.request('conversations.rename', { conversationId, title });
      if (!result.ok) {
        toast.push({ kind: 'error', title: key('ui.session.toast.renameFail'), message: errorText(result.error) });
        return false;
      }
      deps.conversations.getState().patch([conversationId], { title: result.data.title });
      if (deps.active.getState().id === conversationId) deps.active.getState().patchTitle(result.data.title);
      return true;
    },

    async deleteConversation(conversationId, deleteFiles) {
      const files =
        deps.active.getState().id === conversationId ? deps.active.getState().files.map((file) => file.path) : [];
      const result = await deps.request('conversations.delete', { conversationId, deleteFiles });
      if (!result.ok) {
        toast.push({
          kind: 'error',
          title: key('ui.session.toast.deleteConversationFail'),
          message: errorText(result.error)
        });
        return false;
      }
      deps.conversations.getState().remove(conversationId);
      if (deps.active.getState().id === conversationId) deps.active.getState().open(null);
      if (deleteFiles) forgetPaths(files);
      const { filesDeleted: deleted, filesFailed: failed } = result.data;
      toast.push({
        kind: failed > 0 ? 'warn' : 'success',
        title: key('ui.session.toast.conversationDeleted'),
        message:
          failed > 0
            ? key('ui.session.toast.conversationDeletedPartial', { deleted, failed })
            : deleted > 0
              ? key('ui.session.toast.conversationDeletedWithFiles', { count: deleted })
              : key('ui.session.toast.conversationDeletedOnly')
      });
      return true;
    },

    async deleteFiles(paths) {
      if (paths.length === 0) return true;
      // One request for the whole selection (chunked only above the protocol limit).
      const deleted: string[] = [];
      let failed = 0;
      let firstError: AppErrorData | null = null;
      for (let offset = 0; offset < paths.length; offset += 5_000) {
        const result = await deps.request('files.delete', { paths: paths.slice(offset, offset + 5_000) });
        if (!result.ok) {
          failed += Math.min(5_000, paths.length - offset);
          firstError ??= result.error;
          continue;
        }
        deleted.push(...result.data.deleted);
        failed += result.data.failed.length;
        firstError ??= result.data.failed[0]?.error ?? null;
      }
      forgetPaths(deleted);
      if (deleted.length > 0) deps.conversations.getState().scheduleRefresh();
      if (failed > 0 && deleted.length === 0) {
        toast.push({
          kind: 'error',
          title: key('ui.session.toast.deleteFail'),
          message: firstError ? errorText(firstError) : null
        });
        return false;
      }
      toast.push(
        failed > 0
          ? {
              kind: 'warn',
              title: key('ui.session.toast.deletePartial'),
              message: key('ui.session.toast.deletePartialMsg', { removed: deleted.length, failed })
            }
          : {
              kind: 'success',
              title: key('ui.session.toast.filesRemoved', { count: deleted.length }),
              message: key('ui.session.toast.deletedMsg', { count: deleted.length })
            }
      );
      return failed === 0;
    },

    async moveToFolder(conversationIds, folderId) {
      if (conversationIds.length === 0) return true;
      const previous = deps.conversations.getState().items.filter((item) => conversationIds.includes(item.id));
      deps.conversations.getState().patch(conversationIds, { folderId });
      const result = await deps.request('conversations.moveToFolder', {
        conversationIds: [...conversationIds],
        folderId
      });
      if (!result.ok) {
        for (const item of previous) deps.conversations.getState().patch([item.id], { folderId: item.folderId });
        toast.push({ kind: 'error', title: key('ui.sidebar.moveFail'), message: errorText(result.error) });
        return false;
      }
      expandFolder(folderId);
      return true;
    },

    selectConversation(conversationId) {
      deps.composer.getState().setPendingFolder(null);
      deps.active.getState().open(conversationId);
    },

    newDownload(folderId = null) {
      deps.active.getState().open(null);
      deps.composer.getState().newPrompt(folderId);
      expandFolder(folderId);
    }
  };
}
