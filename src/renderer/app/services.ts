/**
 * Composition root of the renderer: builds every store and action object once
 * per window and wires their dependencies. Components reach them through
 * `ServicesProvider` (no module-level singletons).
 */
import type { YamiApi } from '../../shared/contracts/ipc.ts';
import { createYamiClient, type YamiClient } from '../shared/api/yami-client.ts';
import { createMediaUrlCache, type MediaUrlCache } from '../shared/lib/media-cache.ts';
import type { Scheduler } from '../shared/lib/scheduler.ts';
import { createDownloadActions, type DownloadActions } from '../features/downloads/download-actions.ts';
import {
  createActiveConversationStore,
  type ActiveConversationStore
} from '../features/downloads/store/active-conversation-store.ts';
import { createComposerStore, type ComposerStore } from '../features/downloads/store/composer-store.ts';
import { createConversationsStore, type ConversationsStore } from '../features/downloads/store/conversations-store.ts';
import { createFoldersStore, type FoldersStore } from '../features/downloads/store/folders-store.ts';
import { createHostStore, type HostStore } from '../features/host/host-store.ts';
import { createLogsStore, type LogsStore } from '../features/logs/logs-store.ts';
import { createNoticesStore, type NoticesStore } from '../features/notices/notices-store.ts';
import { createPreviewStore, type PreviewStore } from '../features/preview/preview-store.ts';
import { createCookiesStore, type CookiesStore } from '../features/settings/cookies/cookies-store.ts';
import { createRuntimeActions, type RuntimeActions } from '../features/settings/runtime/runtime-actions.ts';
import { createRuntimeStore, type RuntimeStore } from '../features/settings/runtime/runtime-store.ts';
import { createSettingsStore, type SettingsStore } from '../features/settings/settings-store.ts';
import { createUpdatesStore, type UpdatesStore } from '../features/settings/updates/updates-store.ts';
import { createVaultActions, type VaultActions } from '../features/vault/vault-actions.ts';
import { createFileActions, type FileActions } from './file-actions.ts';
import { createUiStore, type UiStore } from './ui-store.ts';

export interface Services {
  readonly client: YamiClient;
  readonly scheduler: Scheduler;
  readonly media: MediaUrlCache;
  readonly host: HostStore;
  readonly settings: SettingsStore;
  readonly notices: NoticesStore;
  readonly logs: LogsStore;
  readonly runtime: RuntimeStore;
  readonly updates: UpdatesStore;
  readonly cookies: CookiesStore;
  readonly conversations: ConversationsStore;
  readonly active: ActiveConversationStore;
  readonly folders: FoldersStore;
  readonly composer: ComposerStore;
  readonly preview: PreviewStore;
  readonly ui: UiStore;
  readonly actions: {
    readonly downloads: DownloadActions;
    readonly files: FileActions;
    readonly runtime: RuntimeActions;
    readonly vault: VaultActions;
  };
}

export function createServices(api: YamiApi, scheduler: Scheduler): Services {
  const client = createYamiClient(api);
  const { request } = client;

  const media = createMediaUrlCache({
    fetcher: (kind, path) =>
      kind === 'preview'
        ? client.call((bridge) => bridge.media.preview(path))
        : client.call((bridge) => bridge.media.thumbnail(path, kind === 'thumbnail-large' ? 'large' : 'small')),
    now: scheduler.now
  });

  const host = createHostStore({
    request,
    scheduler,
    restartHost: async () => {
      const result = await client.call((bridge) => bridge.host.restart());
      return result.ok ? null : result.error;
    }
  });
  const notices = createNoticesStore({
    now: scheduler.now,
    clearHostError: () => void request('notices.clearError', {})
  });
  const settings = createSettingsStore({
    get: () => client.value((bridge) => bridge.settings.get()),
    update: (patch) => client.call((bridge) => bridge.settings.update(patch))
  });
  const updates = createUpdatesStore({
    getStatus: () => client.value((bridge) => bridge.updates.getStatus()),
    check: () => client.call((bridge) => bridge.updates.check()),
    install: () => client.call((bridge) => bridge.updates.install())
  });
  const conversations = createConversationsStore({ request, scheduler });
  const composer = createComposerStore();
  const active = createActiveConversationStore({
    request,
    scheduler,
    onMissing: (id) => {
      conversations.getState().remove(id);
      active.getState().open(null);
    }
  });
  const folders = createFoldersStore({ request });
  const preview = createPreviewStore();
  const runtime = createRuntimeStore({ scheduler });
  const logs = createLogsStore({ request });
  const cookies = createCookiesStore({ request });
  const ui = createUiStore();

  return {
    client,
    scheduler,
    media,
    host,
    settings,
    notices,
    logs,
    runtime,
    updates,
    cookies,
    conversations,
    active,
    folders,
    composer,
    preview,
    ui,
    actions: {
      downloads: createDownloadActions({
        request,
        notices,
        conversations,
        active,
        composer,
        folders,
        preview,
        media
      }),
      files: createFileActions({ client, notices }),
      runtime: createRuntimeActions({ request, runtime, host, notices }),
      vault: createVaultActions({ reset: () => client.call((bridge) => bridge.vault.reset()), notices })
    }
  };
}
