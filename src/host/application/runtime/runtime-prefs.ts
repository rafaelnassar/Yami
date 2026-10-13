/**
 * The runtime fields of the host settings row (mode, setup dismissal, update-check
 * results). Cached in memory; writes are load-modify-save because other services
 * own the remaining fields of the same row.
 */
import type { HostSettings, HostSettingsRepository } from '../ports/persistence.ts';

export type RuntimePrefs = Pick<HostSettings, 'runtimeMode' | 'setupDismissed' | 'toolUpdates'>;

export class RuntimePrefsStore {
  readonly #repository: HostSettingsRepository;
  #cache: RuntimePrefs | null = null;

  constructor(repository: HostSettingsRepository) {
    this.#repository = repository;
  }

  get(): RuntimePrefs {
    this.#cache ??= RuntimePrefsStore.#pick(this.#repository.load());
    return this.#cache;
  }

  update(patch: Partial<RuntimePrefs>): void {
    const next = { ...this.#repository.load(), ...patch };
    this.#repository.save(next);
    this.#cache = RuntimePrefsStore.#pick(next);
  }

  static #pick(settings: HostSettings): RuntimePrefs {
    return {
      runtimeMode: settings.runtimeMode,
      setupDismissed: settings.setupDismissed,
      toolUpdates: settings.toolUpdates
    };
  }
}

/**
 * Runs `task` without overlap. A call made while it runs queues exactly one more
 * run (its inputs may have changed) and resolves when that run completes.
 */
export class CoalescingTask {
  readonly #task: () => Promise<void>;
  #running: Promise<void> | null = null;
  #queued: Promise<void> | null = null;

  constructor(task: () => Promise<void>) {
    this.#task = task;
  }

  run(): Promise<void> {
    if (!this.#running) {
      this.#running = this.#task().finally(() => {
        this.#running = null;
      });
      return this.#running;
    }
    this.#queued ??= this.#running.then(() => {
      this.#queued = null;
      return this.run();
    });
    return this.#queued;
  }
}
