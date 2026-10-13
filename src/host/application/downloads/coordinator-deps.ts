/**
 * Dependencies and options of the downloads core (`DownloadCoordinator`).
 * Everything is injected by the composition root; tests pass fakes from `./testing`.
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import { newId } from '../../../shared/kernel/ids.ts';
import type { BrowserCookieDetector, EngineEnvironment, EngineRegistry, HostPlatform } from '../ports/engines.ts';
import type {
  DownloadedFileMarker,
  FileSystemPort,
  JobWorkspace,
  LogReaderFactory,
  PathSandbox
} from '../ports/files.ts';
import type { PersistenceContext } from '../ports/persistence.ts';
import type { ProcessInspector, ProcessLauncher, ProcessTerminator } from '../ports/processes.ts';
import type { ToolRegistry } from '../ports/runtime.ts';
import type { CookieVault, CredentialVault } from '../ports/secrets.ts';
import type { EventSink, Logger } from '../ports/system.ts';
import type { BackgroundTasks } from './background-tasks.ts';
import { realTimers, type TimerPort } from './timers.ts';

export interface DownloadCoordinatorOptions {
  /** Weighted concurrency budget (gallery-dl 1, yt-dlp 2). */
  readonly maxSlotWeight: number;
  /** Supervision cadence: fastest interval (after activity) and slowest (idle). */
  readonly pollMinMs: number;
  readonly pollMaxMs: number;
  /** Polls without log growth before a strict identity check of a re-attached process. */
  readonly staleStrictCheckPolls: number;
  /** Min interval between (cheap, batched) liveness checks of re-attached processes. */
  readonly livenessEveryMs: number;
  /** Min interval between persisting counters/log offset of a running download (file inserts persist at once). */
  readonly persistEveryMs: number;
  /** Total budget of `shutdown` (main waits ≤ 20 s for the reply). */
  readonly shutdownDeadlineMs: number;
  /** Directories that must never appear in published text (vault, job workspaces, temp). */
  readonly sensitiveDirs: readonly string[];
  readonly platform: HostPlatform;
}

export const DEFAULT_COORDINATOR_OPTIONS = {
  maxSlotWeight: 8,
  pollMinMs: 300,
  pollMaxMs: 1000,
  staleStrictCheckPolls: 8,
  livenessEveryMs: 2000,
  persistEveryMs: 2000,
  shutdownDeadlineMs: 12_000
} as const;

export type DownloadCoordinatorOptionsInput = Partial<DownloadCoordinatorOptions> &
  Pick<DownloadCoordinatorOptions, 'sensitiveDirs' | 'platform'>;

/** Generates ids for batches (`prefix = 'b-'`) and downloads. */
export type IdGenerator = (prefix?: string) => string;

export interface DownloadCoordinatorDeps {
  readonly persistence: PersistenceContext;
  readonly engines: EngineRegistry;
  readonly tools: ToolRegistry;
  readonly engineEnvironment: EngineEnvironment;
  readonly launcher: ProcessLauncher;
  readonly inspector: ProcessInspector;
  readonly terminator: ProcessTerminator;
  readonly logReaders: LogReaderFactory;
  readonly workspace: JobWorkspace;
  readonly cookieVault: CookieVault;
  readonly credentialVault: CredentialVault;
  readonly browserCookies: BrowserCookieDetector;
  readonly sandbox: PathSandbox;
  readonly events: EventSink;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly options: DownloadCoordinatorOptionsInput;
  /** Optional: sizes of detected files (`MediaFileDto.sizeBytes`); `null` sizes without it. */
  readonly fileSystem?: FileSystemPort;
  /** Optional: marks every downloaded file as coming from the internet (Mark-of-the-Web / quarantine). */
  readonly fileMarker?: DownloadedFileMarker;
  /**
   * Optional: true while runtime tools are being installed/updated; nothing is
   * launched meanwhile. Call `DownloadCoordinator.reschedule()` when it changes.
   */
  readonly runtimeBusy?: () => boolean;
  /** Optional (tests): timer source for the supervision loop and the shutdown deadline. */
  readonly timers?: TimerPort;
  /** Optional (tests): id generator. */
  readonly ids?: IdGenerator;
  /** Optional (tests): tracker of background work, to await it (`whenIdle`). */
  readonly background?: BackgroundTasks;
}

export function resolveOptions(input: DownloadCoordinatorOptionsInput): DownloadCoordinatorOptions {
  const pollMinMs = Math.max(1, input.pollMinMs ?? DEFAULT_COORDINATOR_OPTIONS.pollMinMs);
  return {
    maxSlotWeight: input.maxSlotWeight ?? DEFAULT_COORDINATOR_OPTIONS.maxSlotWeight,
    pollMinMs,
    pollMaxMs: Math.max(pollMinMs, input.pollMaxMs ?? DEFAULT_COORDINATOR_OPTIONS.pollMaxMs),
    staleStrictCheckPolls: Math.max(
      1,
      input.staleStrictCheckPolls ?? DEFAULT_COORDINATOR_OPTIONS.staleStrictCheckPolls
    ),
    livenessEveryMs: Math.max(0, input.livenessEveryMs ?? DEFAULT_COORDINATOR_OPTIONS.livenessEveryMs),
    persistEveryMs: Math.max(0, input.persistEveryMs ?? DEFAULT_COORDINATOR_OPTIONS.persistEveryMs),
    shutdownDeadlineMs: Math.max(1, input.shutdownDeadlineMs ?? DEFAULT_COORDINATOR_OPTIONS.shutdownDeadlineMs),
    sensitiveDirs: [...input.sensitiveDirs],
    platform: input.platform
  };
}

export function resolveTimers(deps: DownloadCoordinatorDeps): TimerPort {
  return deps.timers ?? realTimers;
}

export function resolveIds(deps: DownloadCoordinatorDeps): IdGenerator {
  return deps.ids ?? ((prefix = '') => newId(prefix));
}
