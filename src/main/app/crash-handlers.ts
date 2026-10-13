/**
 * Process-level failure handling: uncaught errors are written to `main.log` (the legacy
 * app swallowed them silently), crashed renderers of our windows are reloaded with a
 * bounded backoff, and gone child processes are logged.
 */
import type { App } from 'electron';
import { describeError, type Logger } from '../infrastructure/logger.ts';
import type { Timers } from '../infrastructure/timers.ts';
import type { WindowRegistry } from '../windows/window-registry.ts';
import { RendererRecovery } from './renderer-recovery.ts';

export function installProcessErrorLogging(logger: Logger): void {
  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException', describeError(error));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', describeError(reason));
  });
}

export interface CrashHandlerDeps {
  readonly app: App;
  readonly registry: WindowRegistry;
  readonly timers: Timers;
  readonly now: () => number;
  readonly logger: Logger;
}

export function installCrashHandlers(deps: CrashHandlerDeps): void {
  const recovery = new RendererRecovery(deps.now);
  const { logger } = deps;

  deps.app.on('render-process-gone', (_event, contents, details) => {
    const view = deps.registry.viewOf(contents.id);
    logger.error('renderer process gone', { view, reason: details.reason, exitCode: details.exitCode });
    if (!view) return;
    const decision = recovery.onGone(view, details.reason);
    if (!decision.reload) {
      logger.error('renderer keeps crashing; not reloading', { view });
      return;
    }
    deps.timers.schedule(() => {
      if (!contents.isDestroyed()) contents.reload();
    }, decision.delayMs);
  });

  deps.app.on('child-process-gone', (_event, details) => {
    logger.warn('child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name ?? details.serviceName ?? null
    });
  });
}
