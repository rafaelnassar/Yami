/**
 * React access to the composition root. Feature components read stores with the
 * `use*` selectors below; selectors should return primitives or stable objects.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ActiveConversationState } from '../features/downloads/store/active-conversation-store.ts';
import type { ComposerState } from '../features/downloads/store/composer-store.ts';
import type { ConversationsStoreState } from '../features/downloads/store/conversations-store.ts';
import type { FoldersStoreState } from '../features/downloads/store/folders-store.ts';
import type { HostStoreState } from '../features/host/host-store.ts';
import type { LogsStoreState } from '../features/logs/logs-store.ts';
import type { NoticesStoreState } from '../features/notices/notices-store.ts';
import type { PreviewState } from '../features/preview/preview-store.ts';
import type { CookiesStoreState } from '../features/settings/cookies/cookies-store.ts';
import type { RuntimeStoreState } from '../features/settings/runtime/runtime-store.ts';
import type { SettingsStoreState } from '../features/settings/settings-store.ts';
import type { UpdatesStoreState } from '../features/settings/updates/updates-store.ts';
import type { Services } from './services.ts';
import type { UiState } from './ui-store.ts';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('ServicesProvider is missing');
  return services;
}

export const useHost = <T,>(selector: (state: HostStoreState) => T): T => useStore(useServices().host, selector);
export const useSettings = <T,>(selector: (state: SettingsStoreState) => T): T =>
  useStore(useServices().settings, selector);
export const useNotices = <T,>(selector: (state: NoticesStoreState) => T): T =>
  useStore(useServices().notices, selector);
export const useLogs = <T,>(selector: (state: LogsStoreState) => T): T => useStore(useServices().logs, selector);
export const useRuntime = <T,>(selector: (state: RuntimeStoreState) => T): T =>
  useStore(useServices().runtime, selector);
export const useUpdates = <T,>(selector: (state: UpdatesStoreState) => T): T =>
  useStore(useServices().updates, selector);
export const useCookies = <T,>(selector: (state: CookiesStoreState) => T): T =>
  useStore(useServices().cookies, selector);
export const useConversations = <T,>(selector: (state: ConversationsStoreState) => T): T =>
  useStore(useServices().conversations, selector);
export const useActiveConversation = <T,>(selector: (state: ActiveConversationState) => T): T =>
  useStore(useServices().active, selector);
export const useFolders = <T,>(selector: (state: FoldersStoreState) => T): T =>
  useStore(useServices().folders, selector);
export const useComposer = <T,>(selector: (state: ComposerState) => T): T => useStore(useServices().composer, selector);
export const usePreview = <T,>(selector: (state: PreviewState) => T): T => useStore(useServices().preview, selector);
export const useUi = <T,>(selector: (state: UiState) => T): T => useStore(useServices().ui, selector);
