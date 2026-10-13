/**
 * Graceful restart/shutdown sequences for `HostClient`.
 */
import { COMMAND_SPECS } from '../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import { describeError } from '../infrastructure/logger.ts';
import { unavailableError, type HostProcessSlot } from './host-client-process.ts';
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';

export async function restartWith(
  slot: HostProcessSlot,
  setStatus: (status: HostConnectionStatus) => void,
  whileStopped: () => Promise<void>,
  trackStop: (stop: Promise<unknown> | null) => void,
  trackStarting: (value: boolean) => void
): Promise<Result<null, AppErrorData>> {
  if (slot.phase === 'disposed' || slot.stopping) return err(appError(ErrorCode.HOST_SHUTTING_DOWN));
  if (slot.suspended) return err(appError(ErrorCode.HOST_RESTARTING));
  slot.suspended = true;
  const wasReady = slot.phase === 'ready';
  const previous = slot.process;
  let skipped: AppErrorData | null = null;
  slot.phase = 'starting';
  setStatus({ state: 'starting' });
  try {
    if (wasReady) {
      const stopTimeoutMs = COMMAND_SPECS['lifecycle.shutdown'].timeoutMs;
      const stop = slot.send('lifecycle.shutdown', { mode: 'pause' }, stopTimeoutMs);
      trackStop(stop);
      const stopped = await stop.finally(() => {
        trackStop(null);
      });
      if (!stopped.ok) {
        slot.logger.warn('host did not stop cleanly before the restart', { code: stopped.error.code });
      }
    }
    if (slot.isClosing()) return err(appError(ErrorCode.HOST_SHUTTING_DOWN));
    slot.teardown(ErrorCode.HOST_RESTARTING);
    if (previous && !(await slot.waitExit(previous))) {
      slot.logger.warn('previous host did not exit in time; the restart task is skipped');
      skipped = appError(ErrorCode.HOST_TIMEOUT, { command: 'exit' });
    } else if (!slot.isClosing()) {
      try {
        await whileStopped();
      } catch (error) {
        slot.logger.error('task run while the host was stopped failed', describeError(error));
      }
    }
    if (slot.isClosing()) return err(appError(ErrorCode.HOST_SHUTTING_DOWN));
    slot.policy.reset();
  } finally {
    slot.suspended = false;
  }
  slot.spawn('starting');
  trackStarting(true);
  try {
    const readyBudgetMs = (slot.clientDeps.readyTimeoutMs ?? 20_000) + COMMAND_SPECS['system.configure'].timeoutMs;
    const outcome = await slot.waitReady(readyBudgetMs, () => undefined);
    if (skipped) return err(skipped);
    return outcome === 'ready' ? ok(null) : err(unavailableError(slot.phase, outcome));
  } finally {
    trackStarting(false);
  }
}

export async function shutdownHost(
  slot: HostProcessSlot,
  restartStop: Promise<unknown> | null,
  restartStarting: boolean,
  requestPause: (timeoutMs: number) => Promise<Result<unknown, AppErrorData>>,
  dispose: () => void
): Promise<void> {
  slot.stopping = true;
  const budgetMs = COMMAND_SPECS['lifecycle.shutdown'].timeoutMs;
  const started = slot.clientDeps.now();
  if (restartStop) {
    await restartStop;
  } else if (restartStarting && slot.phase === 'starting') {
    await slot.waitReady(budgetMs, () => undefined);
  }
  if (slot.phase === 'ready') {
    const remainingMs = Math.max(1_000, budgetMs - (slot.clientDeps.now() - started));
    const result = await requestPause(remainingMs);
    if (!result.ok) slot.logger.warn('host shutdown request failed', { code: result.error.code });
  }
  dispose();
}
