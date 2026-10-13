/**
 * The work of each runtime operation, as run by `OperationRunner`: install the
 * tools a mode is missing, update tools, check the upstream feeds. Every plan is
 * computed from a fresh probe (the snapshot may be stale by the time it runs).
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { ok } from '../../../shared/kernel/result.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import type { RuntimeMode, ToolId } from '../../../shared/domain/engine.ts';
import type { ToolStatus } from '../../../shared/domain/runtime.ts';
import type { AfterWork, OperationSummary, OperationWork } from './operation-runner.ts';
import { executePlan, type ExecutorDeps } from './plan-executor.ts';
import { planInstall, planUpdate, type PlanStep } from './install-plan.ts';
import type { RuntimePrefsStore } from './runtime-prefs.ts';
import type { ToolInventory } from './tool-inventory.ts';
import { checkForUpdates } from './update-check.ts';

export interface OperationWorkDeps {
  readonly executor: ExecutorDeps;
  readonly inventory: ToolInventory;
  readonly prefs: RuntimePrefsStore;
  readonly clock: Clock;
  /** Re-probes and publishes the new status (coalesced by the service). */
  readonly refresh: () => Promise<void>;
}

function planWork(
  deps: OperationWorkDeps,
  mode: () => RuntimeMode,
  plan: (mode: RuntimeMode, statuses: ToolStatus[]) => PlanStep[],
  nothingToDo: string
): OperationWork {
  return async (context) => {
    const current = mode();
    const statuses = await deps.inventory.fresh(current);
    const steps = plan(current, statuses);
    if (steps.length === 0) return ok({ code: nothingToDo, params: {} });
    const input = { mode: current, statuses, latestKnown: deps.inventory.latestKnown() };
    const result = await executePlan(deps.executor, steps, input, context);
    return result.ok ? ok({ code: 'done', params: {} }) : result;
  };
}

export function installWork(deps: OperationWorkDeps, mode: RuntimeMode): OperationWork {
  return planWork(deps, () => mode, planInstall, 'alreadyInstalled');
}

/** After an install: switch the mode, re-probe, report a failure (not a cancellation). */
export function installAfterWork(
  deps: OperationWorkDeps,
  mode: RuntimeMode,
  onFailure: ((error: AppErrorData) => void) | null
): AfterWork {
  return async (result) => {
    // The mode only changes once its tools are in place (legacy switched before installing).
    if (result.ok) deps.prefs.update({ runtimeMode: mode, setupDismissed: true });
    await deps.refresh();
    if (!result.ok && result.error.code !== ErrorCode.CANCELLED) onFailure?.(result.error);
  };
}

/** `requested` = `null` updates every tool with an update available. */
export function updateWork(deps: OperationWorkDeps, requested: readonly ToolId[] | null): OperationWork {
  return planWork(
    deps,
    () => deps.prefs.get().runtimeMode,
    (mode, statuses) => planUpdate(mode, statuses, requested),
    'upToDate'
  );
}

export function checkUpdatesWork(deps: OperationWorkDeps, feeds: readonly ToolId[]): OperationWork {
  return async (context) => {
    const found = await checkForUpdates(deps.executor.releases, deps.executor.manifest, feeds, context);
    if (!found.ok) return found;
    const previous = deps.prefs.get().toolUpdates;
    deps.prefs.update({ toolUpdates: { checkedAt: deps.clock.now(), latest: { ...previous.latest, ...found.value } } });
    await deps.refresh();
    const count = deps.inventory.statuses().filter((s) => s.updateAvailable).length;
    const summary: OperationSummary =
      count > 0 ? { code: 'updatesFound', params: { count } } : { code: 'noUpdates', params: {} };
    return ok(summary);
  };
}
