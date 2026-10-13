/**
 * Builds `runtime.progress` events for one operation.
 *
 * Percent rule (kept from the legacy app, but monotonic within a step):
 * - multi-step operations report the overall percent
 *   `round(((stepIndex + stepPercent / 100) / totalSteps) * 100)`, where an unknown
 *   step percent reuses the last known one (the bar never jumps back);
 * - single-step operations report the step percent, or `null` (indeterminate).
 */
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { Params, RuntimeProgressDto, RuntimeProgressPhase } from '../../../shared/contracts/dto.ts';

export type PublishProgress = (progress: RuntimeProgressDto) => void;

/** Share of a step reached at the start of each phase (downloads fill 0–80). */
export const PHASE_PERCENT = { start: 0, verify: 82, extract: 86, install: 92, done: 100 } as const;
const DOWNLOAD_SHARE = 80;

/** Display names are brands, not translatable text. */
export const TOOL_NAMES: Readonly<Record<ToolId, string>> = {
  'gallery-dl': 'gallery-dl',
  'yt-dlp': 'yt-dlp',
  deno: 'Deno',
  ffmpeg: 'ffmpeg',
  python: 'Python'
};

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export class OperationProgress {
  readonly operationId: string;
  readonly #publish: PublishProgress;
  readonly #clock: Clock;
  #total = 1;

  constructor(operationId: string, publish: PublishProgress, clock: Clock) {
    this.operationId = operationId;
    this.#publish = publish;
    this.#clock = clock;
  }

  get totalSteps(): number {
    return this.#total;
  }

  setTotalSteps(total: number): void {
    this.#total = Math.max(1, Math.floor(total));
  }

  operation(phase: 'start' | 'done' | 'error', code: string, params: Params = {}, tool: ToolId | null = null): void {
    const percent = phase === 'done' ? 100 : phase === 'start' && this.#total > 1 ? 0 : null;
    this.emit({ tool, phase, code, params, percent, stepIndex: null });
  }

  step(index: number, tool: ToolId): StepProgress {
    return new StepProgress(this, index, tool);
  }

  /** @internal used by `StepProgress`. */
  emit(event: {
    readonly tool: ToolId | null;
    readonly phase: RuntimeProgressPhase;
    readonly code: string;
    readonly params: Params;
    readonly percent: number | null;
    readonly stepIndex: number | null;
  }): void {
    const multi = this.#total > 1;
    this.#publish({
      operationId: this.operationId,
      tool: event.tool,
      phase: event.phase,
      code: event.code,
      params: event.params,
      percent: event.percent,
      step: multi && event.stepIndex !== null ? event.stepIndex + 1 : null,
      totalSteps: multi ? this.#total : null,
      ts: this.#clock.now()
    });
  }

  /** Overall percent for a step-relative percent (see module doc). */
  overall(index: number, stepPercent: number | null): number | null {
    if (this.#total > 1) return Math.round(((index + clamp(stepPercent ?? 0) / 100) / this.#total) * 100);
    return stepPercent === null ? null : Math.round(clamp(stepPercent));
  }
}

export class StepProgress {
  readonly #operation: OperationProgress;
  readonly #index: number;
  readonly tool: ToolId;
  #lastPercent: number | null = null;
  #lastKey = '';

  constructor(operation: OperationProgress, index: number, tool: ToolId) {
    this.#operation = operation;
    this.#index = index;
    this.tool = tool;
  }

  get name(): string {
    return TOOL_NAMES[this.tool];
  }

  /** Emits one event; `stepPercent` `undefined`/`null` keeps the last known value. */
  phase(phase: RuntimeProgressPhase, code: string, params: Params = {}, stepPercent: number | null = null): void {
    if (stepPercent !== null) this.#lastPercent = Math.max(this.#lastPercent ?? 0, clamp(stepPercent));
    const percent = this.#operation.overall(this.#index, this.#lastPercent);
    // Drop exact duplicates (download progress callbacks fire often).
    const key = `${phase}|${code}|${JSON.stringify(params)}|${percent}`;
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    this.#operation.emit({ tool: this.tool, phase, code, params, percent, stepIndex: this.#index });
  }

  download(received: number, total: number | null): void {
    if (total === null || total <= 0) {
      this.phase('download', 'downloading', { name: this.name });
      return;
    }
    const filePercent = Math.min(100, Math.floor((received / total) * 100));
    this.phase(
      'download',
      'downloadingPercent',
      { name: this.name, percent: filePercent },
      (filePercent * DOWNLOAD_SHARE) / 100
    );
  }
}
