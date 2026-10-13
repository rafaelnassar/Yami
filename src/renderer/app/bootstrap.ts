/**
 * Connects the stores to the bridge: event subscriptions, initial loads and
 * reloads whenever the host (re)becomes ready. Returns a disposer (StrictMode
 * mounts effects twice in development, so everything must be idempotent).
 */
import type { AppView, Unsubscribe } from '../../shared/contracts/ipc.ts';
import { syncVaultNotice, vaultStatusKey } from '../features/vault/vault-notice.ts';
import { routeHostEvent } from './host-events.ts';
import type { Services } from './services.ts';

function onHostReady(services: Services, view: AppView): void {
  void services.host.getState().init();
  if (view !== 'main') return;
  void services.conversations.getState().refresh();
  void services.folders.getState().load();
  if (services.active.getState().id) void services.active.getState().reload();
  if (services.cookies.getState().snapshot) void services.cookies.getState().load();
}

export function startServices(services: Services, view: AppView): Unsubscribe {
  const api = services.client.api;
  const subscriptions: Unsubscribe[] = [];
  let disposed = false;

  subscriptions.push(api.host.onEvent((event) => routeHostEvent(services, event)));
  subscriptions.push(api.host.onStatus((status) => services.host.getState().setConnection(status)));
  subscriptions.push(api.settings.onChanged((settings) => services.settings.getState().receive(settings)));
  if (view === 'main')
    subscriptions.push(api.updates.onStatus((status) => services.updates.getState().receive(status)));

  subscriptions.push(
    services.host.subscribe((state, previous) => {
      if (state.connection.state === 'ready' && previous.connection.state !== 'ready') onHostReady(services, view);
      // Errors raised before this window subscribed (e.g. a failed auto-install at
      // startup) only exist in the snapshot's `lastError`.
      if (state.state !== previous.state) services.notices.getState().syncHostError(state.state?.lastError ?? null);
      // A disabled vault keeps a notice (with the reset action) in the main window.
      const vault = state.state?.config.vault ?? null;
      const vaultChanged = vaultStatusKey(vault) !== vaultStatusKey(previous.state?.config.vault);
      if (view === 'main' && vaultChanged) syncVaultNotice(services.notices, vault);
    })
  );

  // The composer mode follows the saved preference the first time settings arrive.
  let composerSeeded = false;
  const seedComposer = (): void => {
    const { loaded, settings } = services.settings.getState();
    if (composerSeeded || !loaded) return;
    composerSeeded = true;
    services.composer.getState().setMode(settings.ui.composerScope);
  };
  subscriptions.push(services.settings.subscribe(seedComposer));

  void services.settings.getState().load();
  if (view === 'main') void services.updates.getState().load();
  void services.client
    .value((bridge) => bridge.host.getStatus())
    .then((result) => {
      if (disposed) return;
      if (result.ok) services.host.getState().setConnection(result.data);
      else void services.host.getState().init();
    });

  return () => {
    disposed = true;
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}
