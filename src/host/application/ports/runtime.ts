/**
 * Runtime tools ports — the boundary between the downloads context and the
 * runtime-tools context (both in the host).
 *
 * The runtime context (application/runtime + infrastructure/runtime) owns
 * detection, install, update and integrity verification of gallery-dl, yt-dlp,
 * ffmpeg, deno and Python. The downloads context only needs `ToolRegistry`.
 */
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import type { Engine, RuntimeMode, ToolId } from '../../../shared/domain/engine.ts';
import type { RuntimeStatusDto } from '../../../shared/contracts/dto.ts';
import type { EngineInfo } from '../../../shared/domain/runtime.ts';
import type { ResolvedExecutable } from './engines.ts';

export interface ToolRegistry {
  /** Resolved engine executable for the current runtime mode, or `null` when missing. */
  resolveEngine(engine: Engine): ResolvedExecutable | null;
  /** Absolute path of a helper tool (`ffmpeg`, `deno`), or `null`. */
  resolveHelper(tool: Extract<ToolId, 'ffmpeg' | 'deno'>): string | null;
  /** Directories to prepend to PATH for engine processes (managed bin, ffmpeg, deno). */
  pathEntries(): readonly string[];
  engines(): Readonly<Record<Engine, EngineInfo>>;
}

export interface RuntimeService extends ToolRegistry {
  status(): RuntimeStatusDto;
  /** Probes every tool (async, non-blocking). Call at startup and after installs. */
  refresh(): Promise<void>;
  setMode(mode: RuntimeMode): Promise<void>;
  dismissSetup(): void;
  /**
   * Starts a background operation. Returns immediately with its id; progress and
   * completion are published as `runtime.progress` / `runtime.operationFinished`.
   * Fails fast with `TOOLS_BUSY` or `TOOLS_DOWNLOADS_ACTIVE`.
   */
  startInstall(mode: RuntimeMode): Result<{ readonly operationId: string }, AppErrorData>;
  startUpdate(tools: readonly ToolId[] | null): Result<{ readonly operationId: string }, AppErrorData>;
  startCheckUpdates(): Result<{ readonly operationId: string }, AppErrorData>;
  /** Installs missing tools in the background once at startup (first run). */
  autoInstallMissing(): void;
  isBusy(): boolean;
  /** Called by the composition root so installs refuse to run while downloads are active. */
  setDownloadsActiveProbe(probe: () => boolean): void;
  /** Registers a listener for status changes (operation started/finished, probes done). Returns unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Cancels in-flight operations (host shutdown). */
  dispose(): Promise<void>;
}
