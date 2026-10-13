/**
 * Assembles the runtime status / engine info snapshots published to the UI.
 * Kept separate from `RuntimeToolsService` so the service only owns lifecycle.
 */
import type { Engine, RuntimeMode } from '../../../shared/domain/engine.ts';
import type { RuntimeOperationDto, RuntimeStatusDto } from '../../../shared/contracts/dto.ts';
import type { EngineInfo, ToolStatus } from '../../../shared/domain/runtime.ts';
import type { PlatformManifest } from './manifest.ts';
import { engineInfos, missingTools } from './tool-status.ts';

export interface RuntimeStatusInputs {
  readonly mode: RuntimeMode;
  readonly setupDismissed: boolean;
  readonly busy: boolean;
  readonly operation: RuntimeOperationDto | null;
  readonly updatesCheckedAt: number | null;
  readonly tools: readonly ToolStatus[];
  readonly probed: boolean;
  readonly manifest: PlatformManifest;
}

export function assembleRuntimeStatus(input: RuntimeStatusInputs): RuntimeStatusDto {
  const { mode, tools, manifest } = input;
  return {
    mode,
    setupNeeded: input.probed && missingTools(tools, mode).length > 0,
    setupDismissed: input.setupDismissed,
    busy: input.busy,
    operation: input.operation,
    updatesCheckedAt: input.updatesCheckedAt,
    tools,
    // Python mode also needs the hash lock of its pip packages.
    // (An unsupported platform is not a missing pin: python mode is refused there with its own error.)
    integrityPinned:
      manifest.fullyPinned && (mode !== 'python' || manifest.pythonLocked || manifest.pythonUnsupported !== null)
  };
}

export function assembleEngineInfos(tools: readonly ToolStatus[]): Readonly<Record<Engine, EngineInfo>> {
  return engineInfos(tools);
}
