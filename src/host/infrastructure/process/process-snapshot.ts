/**
 * What the OS currently reports about a PID. Produced by `ProcessIdentityReader`
 * and compared against a stored `ProcessIdentity` to detect PID reuse.
 */
import type { StartTokenSource } from '../../domain/processes/process-identity.ts';

export interface ProcessSnapshot {
  readonly pid: number;
  /** Lower-cased image name, `null` when unknown. */
  readonly imageName: string | null;
  readonly startToken: string | null;
  readonly startTokenSource: StartTokenSource | null;
  readonly executablePath: string | null;
}

/**
 * Lookup result per PID:
 * - a snapshot: the process is running (fields may be `null` when the OS query
 *   could not read them — "unknown", never "different");
 * - `null`: the OS confirmed there is no such (live) process.
 */
export type ProcessLookup = ProcessSnapshot | null;

export interface ProcessIdentityReader {
  read(pid: number): Promise<ProcessLookup>;
  /** One OS query for many PIDs (Windows/macOS). Every requested PID is present in the map. */
  readMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessLookup>>;
}

export function unknownSnapshot(pid: number): ProcessSnapshot {
  return { pid, imageName: null, startToken: null, startTokenSource: null, executablePath: null };
}

export function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

/** Deduplicated, valid PIDs in input order. */
export function uniquePids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter(isValidPid))];
}
