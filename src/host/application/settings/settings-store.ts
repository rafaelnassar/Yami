/**
 * Read-modify-write access to the persisted host settings.
 *
 * `update` loads, transforms and saves synchronously (the repository is
 * synchronous SQLite), so no other command can interleave between the read and
 * the write. Callers must do any async work (vault checks) *before* `update`.
 */
import type { HostSettings, HostSettingsRepository } from '../ports/persistence.ts';

export class SettingsStore {
  readonly #repository: HostSettingsRepository;

  constructor(repository: HostSettingsRepository) {
    this.#repository = repository;
  }

  read(): HostSettings {
    return this.#repository.load();
  }

  update(change: (current: HostSettings) => HostSettings): HostSettings {
    const next = change(this.#repository.load());
    this.#repository.save(next);
    return next;
  }
}
