/**
 * Builds the `HostStateDto` snapshot from the owners of each piece of state.
 * Synchronous on purpose: it runs on every (throttled) state broadcast.
 */
import type { HostStateDto, VaultStatusDto } from '../../../shared/contracts/dto.ts';
import type { AccountsSource } from '../accounts/accounts-status.ts';
import type { DownloadsFacade } from '../downloads/downloads-facade.ts';
import type { PathSandbox } from '../ports/files.ts';
import type { RuntimeService } from '../ports/runtime.ts';
import type { SettingsStore } from '../settings/settings-store.ts';
import type { LastErrorSource } from './notice-center.ts';

export interface StateProjectorDeps {
  readonly downloads: Pick<DownloadsFacade, 'snapshot'>;
  readonly runtime: Pick<RuntimeService, 'status' | 'engines'>;
  readonly settings: Pick<SettingsStore, 'read'>;
  readonly accounts: AccountsSource;
  readonly sandbox: Pick<PathSandbox, 'downloadDir'>;
  readonly notices: LastErrorSource;
  /** Fixed for the host's lifetime (a vault reset restarts the host). */
  readonly vault: VaultStatusDto;
}

export class StateProjector {
  readonly #deps: StateProjectorDeps;

  constructor(deps: StateProjectorDeps) {
    this.#deps = deps;
  }

  project(): HostStateDto {
    const { downloads, runtime, settings, accounts, sandbox, notices, vault } = this.#deps;
    const snapshot = downloads.snapshot();
    const current = settings.read();
    return {
      status: snapshot.status,
      downloads: { active: snapshot.active, queued: snapshot.queued, batch: snapshot.batch },
      engines: runtime.engines(),
      config: {
        defaultEngine: current.defaultEngine,
        downloadDir: sandbox.downloadDir,
        cookies: { active: current.cookies.active, fromBrowser: current.cookies.fromBrowser },
        accounts: accounts.current(),
        vault
      },
      runtime: runtime.status(),
      lastError: notices.lastError()
    };
  }
}
