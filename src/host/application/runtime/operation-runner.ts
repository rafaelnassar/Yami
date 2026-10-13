/**
 * Single-flight background operations (install / update / check-updates).
 *
 * `start` marks the runner busy synchronously and returns the operation id; the
 * work runs on a later tick and reports through `runtime.progress`. The finish
 * sequence is: work → `afterWork` (refresh/persist, still busy) → final progress
 * event → busy cleared → `runtime.operationFinished`.
 */
import { ErrorCode, toAppErrorData, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { TOOL_IDS, type ToolId } from '../../../shared/domain/engine.ts';
import type { Params, RuntimeOperationDto, RuntimeOperationKind } from '../../../shared/contracts/dto.ts';
import type { EventSink, Logger } from '../ports/system.ts';
import { OperationProgress } from './progress.ts';

/** Final op-level progress line of a successful operation. */
export interface OperationSummary {
  readonly code: string;
  readonly params: Params;
}

export interface OperationContext {
  readonly progress: OperationProgress;
  readonly signal: AbortSignal;
}

export type OperationWork = (context: OperationContext) => Promise<Result<OperationSummary, AppErrorData>>;
export type AfterWork = (result: Result<OperationSummary, AppErrorData>) => Promise<void>;

export interface OperationRunnerDeps {
  readonly events: EventSink;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly newId: () => string;
  /** Called whenever `current` changes (start and finish). */
  readonly onChange: () => void;
}

interface Running {
  readonly dto: RuntimeOperationDto;
  readonly controller: AbortController;
  done: Promise<void>;
}

const DISPOSE_WAIT_MS = 10_000;

function errorTool(error: AppErrorData): ToolId | null {
  const tool = error.params?.['tool'];
  return typeof tool === 'string' && (TOOL_IDS as readonly string[]).includes(tool) ? (tool as ToolId) : null;
}

export class OperationRunner {
  readonly #deps: OperationRunnerDeps;
  #running: Running | null = null;

  constructor(deps: OperationRunnerDeps) {
    this.#deps = deps;
  }

  get current(): RuntimeOperationDto | null {
    return this.#running?.dto ?? null;
  }

  isBusy(): boolean {
    return this.#running !== null;
  }

  /** Caller must check `isBusy()` first (the service turns it into `TOOLS_BUSY`). */
  start(
    kind: RuntimeOperationKind,
    tools: readonly ToolId[],
    startCode: string,
    work: OperationWork,
    afterWork: AfterWork
  ): string {
    if (this.#running) throw new Error('runtime operation already running');
    const { clock, logger, newId } = this.#deps;
    const dto: RuntimeOperationDto = { id: newId(), kind, tools: [...tools], startedAt: clock.now() };
    const running: Running = { dto, controller: new AbortController(), done: Promise.resolve() };
    this.#running = running;
    logger.info('runtime operation started', { operationId: dto.id, kind, tools: dto.tools });
    running.done = this.#run(running, startCode, work, afterWork);
    this.#deps.onChange();
    return dto.id;
  }

  async #run(running: Running, startCode: string, work: OperationWork, afterWork: AfterWork): Promise<void> {
    await Promise.resolve(); // let `start` return (and its caller reply) before any event
    const { events, clock, logger } = this.#deps;
    const { dto, controller } = running;
    const progress = new OperationProgress(
      dto.id,
      (p) => events.publish({ type: 'runtime.progress', progress: p }),
      clock
    );
    progress.operation('start', startCode, { tools: dto.tools.join(', ') });

    let result: Result<OperationSummary, AppErrorData>;
    try {
      result = await work({ progress, signal: controller.signal });
    } catch (error) {
      result = err(toAppErrorData(error));
    }
    if (controller.signal.aborted && result.ok) result = err({ code: ErrorCode.CANCELLED });

    try {
      await afterWork(result);
    } catch (error) {
      logger.error('runtime operation post-processing failed', { operationId: dto.id, error: String(error) });
    }

    if (result.ok) {
      progress.operation('done', result.value.code, result.value.params);
      logger.info('runtime operation finished', { operationId: dto.id });
    } else {
      progress.operation('error', 'failed', { error: result.error.code }, errorTool(result.error));
      logger.warn('runtime operation failed', { operationId: dto.id, error: result.error });
    }
    this.#running = null;
    this.#deps.onChange();
    events.publish({
      type: 'runtime.operationFinished',
      operationId: dto.id,
      ok: result.ok,
      error: result.ok ? null : result.error
    });
  }

  /** Aborts the in-flight operation and waits (bounded) for it to settle. */
  async dispose(): Promise<void> {
    const running = this.#running;
    if (!running) return;
    running.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DISPOSE_WAIT_MS);
    });
    await Promise.race([running.done, timeout]);
    clearTimeout(timer);
  }
}
