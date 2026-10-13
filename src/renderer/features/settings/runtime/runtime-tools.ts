/** Pure helpers for the runtime tools panel. */
import type { RuntimeStatusDto, ToolStatusDto } from '../../../../shared/contracts/dto.ts';
import type { ToolId, ToolSource } from '../../../../shared/domain/engine.ts';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';

export const TOOL_ORDER: readonly ToolId[] = ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'];

export function emptyTool(id: ToolId): ToolStatusDto {
  return {
    id,
    installed: false,
    version: null,
    source: 'none',
    path: null,
    pinnedVersion: null,
    latestVersion: null,
    updateAvailable: false
  };
}

/** Tools in display order, missing entries filled in. */
export function orderedTools(tools: readonly ToolStatusDto[]): ToolStatusDto[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return TOOL_ORDER.map((id) => byId.get(id) ?? emptyTool(id));
}

/** A system Python is never touched; only a missing or app-managed one can be (re)installed. */
export function canMutateTool(tool: ToolStatusDto): boolean {
  return tool.id !== 'python' || !tool.installed || tool.source === 'managed';
}

export const SOURCE_KEYS: Readonly<Record<ToolSource, MessageKey>> = {
  managed: 'ui.runtime.source.managed',
  system: 'ui.runtime.source.system',
  python: 'ui.runtime.source.python',
  env: 'ui.runtime.source.env',
  none: 'ui.runtime.source.none'
};

export function pendingUpdates(tools: readonly ToolStatusDto[]): readonly ToolId[] {
  return tools.filter((tool) => tool.installed && tool.updateAvailable && canMutateTool(tool)).map((tool) => tool.id);
}

export type RuntimeCaption = { readonly key: MessageKey; readonly count?: number };

export function runtimeCaption(runtime: RuntimeStatusDto, checking: boolean, pending: number): RuntimeCaption {
  if (checking) return { key: 'ui.runtime.checkingUpdates' };
  if (pending > 0) return { key: 'ui.runtime.pendingHint', count: pending };
  if (runtime.updatesCheckedAt) return { key: 'ui.runtime.upToDate' };
  return { key: 'ui.runtime.ffmpegHint' };
}
