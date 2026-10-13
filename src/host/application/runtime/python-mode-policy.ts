/**
 * Whether python mode may install its pip packages on this platform (pure).
 *
 * Packaged builds only pip-install the platform's hash lock; a platform the
 * manifest marks unsupported (no compatible wheels, `lock.<platform>.unsupported`)
 * has no python mode at all — standalone mode is unaffected. Dev builds are never
 * refused here: they fall back to the pinned requirements with a warning
 * (`install-steps.ts`). The operations check this before any step runs, so the
 * managed Python is never downloaded or replaced for an install pip would refuse.
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { PlatformManifest } from './manifest.ts';
import type { PlanStep } from './install-plan.ts';
import { isEngineTool } from './tool-status.ts';

/** `params.reason` of `TOOLS_UNSUPPORTED_PLATFORM` for python mode (`errors.TOOLS_UNSUPPORTED_PLATFORM_pythonMode`). */
export const PYTHON_MODE_UNSUPPORTED = 'pythonMode';

export function pythonModeRefusal(manifest: PlatformManifest, isPackaged: boolean): AppErrorData | null {
  if (!isPackaged) return null;
  if (manifest.pythonUnsupported !== null) {
    return { code: ErrorCode.TOOLS_UNSUPPORTED_PLATFORM, params: { tool: 'python', reason: PYTHON_MODE_UNSUPPORTED } };
  }
  if (!manifest.pythonLocked) return { code: ErrorCode.TOOLS_NOT_PINNED, params: { tool: 'python' } };
  return null;
}

/** Python-mode tools: the managed Python and the engines (pip packages). */
export function touchesPythonMode(tools: readonly ToolId[]): boolean {
  return tools.some((tool) => tool === 'python' || isEngineTool(tool));
}

/** Whether a python-mode plan replaces the managed Python or pip-installs. */
export function planTouchesPython(plan: readonly PlanStep[]): boolean {
  return plan.some((step) => step.kind === 'python' || step.kind === 'pip');
}
