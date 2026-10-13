/**
 * `settings.setDownloadDir` (main-only, after the native folder picker).
 * The sandbox validates the candidate (absolute, not a system/app directory,
 * does not contain protected dirs), creates it and returns its canonical form.
 */
import type { CommandPayload, CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import type { LibraryScanner, PathSandbox } from '../ports/files.ts';
import type { EventSink } from '../ports/system.ts';
import type { StateChangeNotifier } from '../session/state-publisher.ts';
import type { SettingsStore } from './settings-store.ts';

export interface SetDownloadDirDeps {
  readonly sandbox: Pick<PathSandbox, 'validateDownloadDir' | 'setDownloadDir'>;
  readonly settings: Pick<SettingsStore, 'update'>;
  readonly scanner: Pick<LibraryScanner, 'invalidate'>;
  readonly events: EventSink;
  readonly state: StateChangeNotifier;
}

export class SetDownloadDirService {
  readonly #deps: SetDownloadDirDeps;

  constructor(deps: SetDownloadDirDeps) {
    this.#deps = deps;
  }

  async setDownloadDir(
    payload: CommandPayload<'settings.setDownloadDir'>
  ): Promise<Result<CommandResult<'settings.setDownloadDir'>, AppErrorData>> {
    const { sandbox, settings, scanner, state } = this.#deps;
    const validated = await sandbox.validateDownloadDir(payload.path);
    if (!validated.ok) return validated;
    const downloadDir = validated.value;
    sandbox.setDownloadDir(downloadDir);
    settings.update((current) => ({ ...current, downloadDir }));
    scanner.invalidate();
    state.stateChanged();
    return ok({ downloadDir });
  }
}
