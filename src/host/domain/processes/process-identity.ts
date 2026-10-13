/**
 * Identity of an OS process started for a download. Stored with the download so
 * a restarted host can re-attach to (or safely kill) the right process, without
 * being fooled by PID reuse.
 */
export type StartTokenSource = 'wmic' | 'powershell' | 'proc' | 'ps';

export interface ProcessIdentity {
  readonly pid: number;
  /** Lower-cased image name (e.g. `yt-dlp.exe`), `null` when it could not be read. */
  readonly imageName: string | null;
  /**
   * Opaque process start marker. Only comparable with another token from the SAME
   * `startTokenSource` — tokens from different sources must be treated as "unknown",
   * never as "different process".
   */
  readonly startToken: string | null;
  readonly startTokenSource: StartTokenSource | null;
  /** Absolute path of the executable that was launched. */
  readonly executable: string | null;
  readonly capturedAt: number;
}
