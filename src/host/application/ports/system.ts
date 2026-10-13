/**
 * Cross-cutting ports: logging, event publication and host environment.
 */
import type { HostEvent } from '../../../shared/contracts/host-protocol.ts';
import type { HostPlatform } from './engines.ts';

export type LogFields = Readonly<Record<string, unknown>>;

/** Structured diagnostic logger (writes the rotating `host.log`, with secret redaction). */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/**
 * Publishes protocol events to the main process. The interface layer applies
 * throttling (state ≤ 4/s) and batching (logs, files) — publishers just publish.
 */
export interface EventSink {
  publish(event: HostEvent): void;
}

export interface HostPaths {
  /** App data (db, logs of jobs, vault, per-job workspaces). */
  readonly dataDir: string;
  /** Managed tools (bin/, python/). */
  readonly runtimeDir: string;
  readonly logsDir: string;
  readonly tempDir: string;
  /** Legacy `~/.yami` to import once, or `null`. */
  readonly legacyDir: string | null;
  /** Directories that must never be used for (or contain) downloads. */
  readonly protectedDirs: readonly string[];
}

export interface HostEnvironment {
  readonly platform: HostPlatform;
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly paths: HostPaths;
  readonly defaultDownloadDir: string;
}
