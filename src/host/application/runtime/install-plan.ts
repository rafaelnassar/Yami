/**
 * Decides which steps an install/update operation runs (pure).
 *
 * - install: only what is missing for the mode (tools found anywhere are kept —
 *   the legacy setup re-downloaded everything).
 * - update: the requested tools (or every tool with an update) that are missing or
 *   outdated; an up-to-date tool is skipped. The mode is never changed by an update.
 * - python mode: a step that installs or replaces the managed Python also installs
 *   every engine into the new distribution before it is swapped in (`packages`), so
 *   a Python update can never leave the engines missing; no separate pip step then.
 */
import { ENGINES, type Engine, type RuntimeMode, type ToolId } from '../../../shared/domain/engine.ts';
import type { ToolStatus } from '../../../shared/domain/runtime.ts';
import { isEngineTool, requiredTools } from './tool-status.ts';

export type ExecutableTool = Exclude<ToolId, 'python'>;

export type PlanStep =
  | { readonly kind: 'executable'; readonly tool: ExecutableTool }
  | {
      readonly kind: 'python';
      /** Engines pip-installed into the new distribution before it replaces the current one. */
      readonly packages: readonly Engine[];
    }
  | { readonly kind: 'pip'; readonly engines: readonly Engine[] };

const EXECUTABLE_ORDER: readonly ExecutableTool[] = ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg'];

function byId(statuses: readonly ToolStatus[]): Map<ToolId, ToolStatus> {
  return new Map(statuses.map((s) => [s.id, s]));
}

function assemble(
  mode: RuntimeMode,
  python: boolean,
  pipEngines: readonly Engine[],
  executables: ReadonlySet<ExecutableTool>
): PlanStep[] {
  const steps: PlanStep[] = [];
  // A fresh distribution has no packages: in python mode it gets every engine, not only the outdated ones.
  if (python) steps.push({ kind: 'python', packages: mode === 'python' ? [...ENGINES] : [] });
  else if (pipEngines.length > 0) steps.push({ kind: 'pip', engines: [...pipEngines] });
  for (const tool of EXECUTABLE_ORDER) if (executables.has(tool)) steps.push({ kind: 'executable', tool });
  return steps;
}

export function planInstall(mode: RuntimeMode, statuses: readonly ToolStatus[]): PlanStep[] {
  const status = byId(statuses);
  const missing = (tool: ToolId): boolean => !(status.get(tool)?.installed ?? false);
  const needed = requiredTools(mode).filter(missing);
  const executables = new Set<ExecutableTool>();
  const pipEngines: Engine[] = [];
  for (const tool of needed) {
    if (tool === 'python') continue;
    if (mode === 'python' && isEngineTool(tool)) pipEngines.push(tool);
    else executables.add(tool);
  }
  return assemble(mode, needed.includes('python'), pipEngines, executables);
}

export function planUpdate(
  mode: RuntimeMode,
  statuses: readonly ToolStatus[],
  requested: readonly ToolId[] | null
): PlanStep[] {
  const status = byId(statuses);
  const wanted = requested ?? statuses.filter((s) => s.updateAvailable).map((s) => s.id);
  let python = false;
  const pipEngines: Engine[] = [];
  const executables = new Set<ExecutableTool>();

  for (const tool of new Set(wanted)) {
    const current = status.get(tool);
    const installed = current?.installed ?? false;
    if (installed && !current?.updateAvailable) continue;
    if (tool === 'python') {
      // A system Python is never touched; only a missing or managed one.
      if (!installed || current?.source === 'managed') python = true;
    } else if (mode === 'python' && isEngineTool(tool)) {
      pipEngines.push(tool);
    } else {
      executables.add(tool);
    }
  }
  // pip needs the managed Python.
  if (pipEngines.length > 0 && !(status.get('python')?.installed ?? false)) python = true;
  return assemble(mode, python, pipEngines, executables);
}

/** Tool shown in progress events for a step. */
export function stepTool(step: PlanStep): ToolId {
  if (step.kind === 'executable') return step.tool;
  return 'python';
}
