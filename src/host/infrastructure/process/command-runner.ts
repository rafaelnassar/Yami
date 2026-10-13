/**
 * Thin, injectable wrapper around `child_process.execFile` for short-lived OS
 * commands (tasklist, taskkill, PowerShell, ps…). Every caller goes through this
 * interface so the Windows/macOS branches can be unit-tested on Linux with a fake.
 *
 * Never uses a shell, always hides the console window on Windows and never
 * rejects: failures are reported in the result.
 */
import { execFile } from 'node:child_process';

export interface CommandOptions {
  /** Hard timeout; the child is killed (SIGTERM) when it elapses. */
  readonly timeoutMs: number;
  /** Max bytes buffered per stream (default 4 MiB). */
  readonly maxBuffer?: number;
  /** Complete environment for the child (defaults to the host environment). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code; `null` when the command could not start, timed out or died from a signal. */
  readonly code: number | null;
  /** Short machine-readable failure reason (`ENOENT`, `ETIMEDOUT`, `SIGTERM`, …) or `null`. */
  readonly error: string | null;
}

export interface CommandRunner {
  run(file: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

interface ExecError {
  readonly code?: unknown;
  readonly signal?: unknown;
  readonly killed?: unknown;
}

function asExecError(error: unknown): ExecError {
  return typeof error === 'object' && error !== null ? error : {};
}

function failureReason(error: ExecError): string {
  if (error.killed === true) return 'ETIMEDOUT';
  if (typeof error.code === 'string') return error.code;
  if (typeof error.signal === 'string') return error.signal;
  return 'EFAILED';
}

export class ExecFileCommandRunner implements CommandRunner {
  run(file: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      const done = (error: unknown, stdout: string, stderr: string): void => {
        if (!error) {
          resolve({ stdout, stderr, code: 0, error: null });
          return;
        }
        const info = asExecError(error);
        // A numeric code means the program ran and exited non-zero: not a runner failure.
        if (typeof info.code === 'number') {
          resolve({ stdout, stderr, code: info.code, error: null });
          return;
        }
        resolve({ stdout, stderr, code: null, error: failureReason(info) });
      };
      try {
        execFile(
          file,
          [...args],
          {
            encoding: 'utf8',
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
            windowsHide: true,
            shell: false,
            ...(options.env ? { env: { ...options.env } } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {})
          },
          (error, stdout, stderr) => done(error, String(stdout), String(stderr))
        );
      } catch (error) {
        // execFile throws synchronously for invalid arguments (e.g. NUL bytes).
        done(error, '', '');
      }
    });
  }
}
