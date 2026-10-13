/**
 * Runtime-tool status concepts shared by host application logic and IPC DTOs.
 */
import type { Engine, ToolId, ToolSource } from './engine.ts';

export interface ToolStatus {
  readonly id: ToolId;
  readonly installed: boolean;
  readonly version: string | null;
  readonly source: ToolSource;
  readonly path: string | null;
  readonly pinnedVersion: string | null;
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
}

export interface EngineInfo {
  readonly engine: Engine;
  readonly available: boolean;
  readonly version: string | null;
  readonly source: ToolSource;
}
