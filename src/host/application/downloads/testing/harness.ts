/**
 * Builds a `DownloadCoordinator` wired to fakes, with helpers to drive
 * scheduling and supervision deterministically.
 */
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { Result } from '../../../../shared/kernel/result.ts';
import type { DownloadScope, Engine } from '../../../../shared/domain/engine.ts';
import type { DownloadRecord } from '../../ports/persistence.ts';
import { BackgroundTasks } from '../background-tasks.ts';
import type { DownloadCoordinatorOptionsInput } from '../coordinator-deps.ts';
import { DownloadCoordinator } from '../download-coordinator.ts';
import type { StartDownloadsOutput } from '../downloads-facade.ts';
import {
  FakeBrowserCookieDetector,
  FakeEngineRegistry,
  FakeToolRegistry,
  fakeEngineEnvironment
} from './fake-engines.ts';
import { FakeFileMarker, FakeFileSystem, FakeJobWorkspace, FakePathSandbox, WORK_ROOT } from './fake-files.ts';
import { FakeLogStore } from './fake-logs.ts';
import { InMemoryPersistence } from './fake-persistence.ts';
import { FakeProcessHost } from './fake-processes.ts';
import { FakeCookieVault, FakeCredentialVault } from './fake-secrets.ts';
import { ManualClock, ManualTimers, RecordingEventSink, RecordingLogger } from './fake-system.ts';

export const VAULT_DIR = '/data/vault';

/** Lets every pending promise continuation run (fakes resolve without I/O). */
export async function settleMicrotasks(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface HarnessOptions {
  readonly persistence?: InMemoryPersistence;
  readonly logs?: FakeLogStore;
  readonly processes?: FakeProcessHost;
  readonly clock?: ManualClock;
  readonly options?: Partial<DownloadCoordinatorOptionsInput>;
}

export interface StartOptions {
  readonly engine?: Engine;
  readonly scope?: DownloadScope;
  readonly cookieNames?: readonly (string | null)[] | null;
  readonly folderId?: string | null;
}

export class DownloadsHarness {
  readonly persistence: InMemoryPersistence;
  readonly logs: FakeLogStore;
  readonly processes: FakeProcessHost;
  readonly engines = new FakeEngineRegistry();
  readonly tools = new FakeToolRegistry();
  readonly workspace = new FakeJobWorkspace();
  readonly sandbox = new FakePathSandbox();
  readonly fileSystem = new FakeFileSystem();
  readonly fileMarker = new FakeFileMarker();
  readonly background = new BackgroundTasks();
  /** Simulates runtime tools being installed (`runtimeBusy` dependency). */
  runtimeBusy = false;
  readonly cookieVault = new FakeCookieVault();
  readonly credentials = new FakeCredentialVault();
  readonly browser = new FakeBrowserCookieDetector();
  readonly events = new RecordingEventSink();
  readonly logger = new RecordingLogger();
  readonly clock: ManualClock;
  readonly timers: ManualTimers;
  readonly coordinator: DownloadCoordinator;
  #ids = 0;

  constructor(options: HarnessOptions = {}) {
    this.persistence = options.persistence ?? new InMemoryPersistence();
    this.logs = options.logs ?? new FakeLogStore();
    this.processes = options.processes ?? new FakeProcessHost(this.logs);
    this.clock = options.clock ?? new ManualClock();
    this.timers = new ManualTimers(this.clock);
    this.coordinator = new DownloadCoordinator({
      persistence: this.persistence,
      engines: this.engines,
      tools: this.tools,
      engineEnvironment: fakeEngineEnvironment,
      launcher: this.processes,
      inspector: this.processes,
      terminator: this.processes,
      logReaders: this.logs,
      workspace: this.workspace,
      cookieVault: this.cookieVault,
      credentialVault: this.credentials,
      browserCookies: this.browser,
      sandbox: this.sandbox,
      events: this.events,
      logger: this.logger,
      clock: this.clock,
      fileSystem: this.fileSystem,
      fileMarker: this.fileMarker,
      runtimeBusy: () => this.runtimeBusy,
      background: this.background,
      timers: this.timers,
      ids: (prefix = '') => `${prefix}id${++this.#ids}`,
      options: { sensitiveDirs: [WORK_ROOT, VAULT_DIR], platform: 'linux', ...options.options }
    });
  }

  async start(
    urls: readonly string[],
    options: StartOptions = {}
  ): Promise<Result<StartDownloadsOutput, AppErrorData>> {
    const result = await this.coordinator.start({
      urls,
      engine: options.engine ?? 'gallery-dl',
      scope: options.scope ?? (urls.length > 1 ? 'bulk' : 'single'),
      cookieNames: options.cookieNames ?? null,
      folderId: options.folderId ?? null
    });
    await this.whenIdle();
    return result;
  }

  /** Waits for queued background work (scheduling, launches, supervision passes). */
  whenIdle(): Promise<void> {
    return this.background.whenIdle();
  }

  /** Starts and returns the created ids, failing the test when start fails. */
  async startOk(urls: readonly string[], options: StartOptions = {}): Promise<StartDownloadsOutput> {
    const result = await this.start(urls, options);
    if (!result.ok) throw new Error(`start failed: ${result.error.code}`);
    return result.value;
  }

  /** Runs one supervision pass (if scheduled) and waits for follow-up work. */
  async tick(): Promise<void> {
    await this.whenIdle();
    await this.timers.runNext();
    await this.whenIdle();
  }

  /** Runs supervision passes until nothing is scheduled (or `maxPasses`). */
  async settle(maxPasses = 30): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      await this.whenIdle();
      if (this.timers.pending === 0) return;
      await this.timers.runNext();
    }
    await this.whenIdle();
  }

  record(id: string): DownloadRecord {
    const record = this.persistence.downloads.get(id);
    if (!record) throw new Error(`no record ${id}`);
    return record;
  }
}
