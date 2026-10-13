/** Fakes for `DownloadsFacade` and the read side of `RuntimeService`. */
import type { EngineInfoDto, RuntimeStatusDto } from '../../../shared/contracts/dto.ts';
import type { Engine } from '../../../shared/domain/engine.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type {
  CommandOutcome,
  DownloadsFacade,
  DownloadsSnapshot,
  StartDownloadsOutput
} from '../downloads/downloads-facade.ts';
import type { RuntimeService } from '../ports/runtime.ts';

export const IDLE_SNAPSHOT: DownloadsSnapshot = { status: 'idle', active: [], queued: [], batch: null };

const notSupported = (): CommandOutcome => err(appError(ErrorCode.NOT_SUPPORTED));

export class FakeDownloadsFacade implements DownloadsFacade {
  snapshotValue: DownloadsSnapshot = IDLE_SNAPSHOT;
  readonly forgotten: string[] = [];
  readonly forgetErrors = new Map<string, AppErrorData>();
  /** Invoked inside `forget` (e.g. to assert ordering against persistence). */
  onForget: ((conversationId: string) => void) | null = null;

  async initialize(): Promise<void> {}
  async start(): Promise<Result<StartDownloadsOutput, AppErrorData>> {
    return err(appError(ErrorCode.NOT_SUPPORTED));
  }
  async pause(): Promise<CommandOutcome> {
    return notSupported();
  }
  async resume(): Promise<CommandOutcome> {
    return notSupported();
  }
  async stop(): Promise<CommandOutcome> {
    return notSupported();
  }
  async restart(): Promise<CommandOutcome> {
    return notSupported();
  }
  async pauseAll(): Promise<{ affected: number }> {
    return { affected: 0 };
  }
  async resumeAll(): Promise<{ affected: number }> {
    return { affected: 0 };
  }
  async stopAll(): Promise<{ affected: number }> {
    return { affected: 0 };
  }
  async forget(conversationId: string): Promise<Result<void, AppErrorData>> {
    this.onForget?.(conversationId);
    const failure = this.forgetErrors.get(conversationId);
    if (failure) return err(failure);
    this.forgotten.push(conversationId);
    return ok();
  }
  snapshot(): DownloadsSnapshot {
    return this.snapshotValue;
  }
  hasActive(): boolean {
    return this.snapshotValue.active.length > 0 || this.snapshotValue.queued.length > 0;
  }
  onChange(): () => void {
    return () => {};
  }
  async shutdown(): Promise<void> {}
}

function engineInfo(engine: Engine): EngineInfoDto {
  return { engine, available: true, version: '1.0', source: 'managed' };
}

export const RUNTIME_STATUS: RuntimeStatusDto = {
  mode: 'standalone',
  setupNeeded: false,
  setupDismissed: true,
  busy: false,
  operation: null,
  updatesCheckedAt: null,
  tools: [],
  integrityPinned: true
};

export class FakeRuntimeStatus implements Pick<RuntimeService, 'status' | 'engines'> {
  statusValue: RuntimeStatusDto = RUNTIME_STATUS;

  status(): RuntimeStatusDto {
    return this.statusValue;
  }
  engines(): Readonly<Record<Engine, EngineInfoDto>> {
    return { 'gallery-dl': engineInfo('gallery-dl'), 'yt-dlp': engineInfo('yt-dlp') };
  }
}
