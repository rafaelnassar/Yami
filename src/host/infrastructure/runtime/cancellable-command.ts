/**
 * Cancellable variant of the process module's `CommandRunner`
 * (`infrastructure/process/command-runner.ts`), used only by the two long-running
 * runtime jobs: `pip install` (minutes; its output lines drive the progress UI)
 * and archive extraction (large archives). `ExecFileCommandRunner` can neither be
 * aborted nor stream output, and a user cancel or host shutdown must stop these
 * children at once instead of waiting up to their timeout. Short version probes
 * use the process module's runner directly.
 *
 * Same `execFile` semantics and vocabulary (`CommandOptions`, `CommandResult`),
 * plus `signal` and `onLine`. Failure reasons: `ABORT_ERR` (aborted),
 * `ETIMEDOUT`, `ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, …
 */
import { execFile } from 'node:child_process';
import type { CommandOptions, CommandResult } from '../process/command-runner.ts';

export interface CancellableCommandOptions extends CommandOptions {
  readonly signal: AbortSignal;
  /** Every complete, non-blank stdout/stderr line (CR or LF separated) as it arrives. */
  readonly onLine?: (line: string) => void;
}

export interface CancellableCommandRunner {
  run(file: string, args: readonly string[], options: CancellableCommandOptions): Promise<CommandResult>;
}

export const ABORTED = 'ABORT_ERR';
export const OUTPUT_TOO_LARGE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

class LineSplitter {
  readonly #onLine: (line: string) => void;
  #partial = '';

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(text: string): void {
    const parts = (this.#partial + text).split(/\r\n|\r|\n/);
    this.#partial = parts.pop() ?? '';
    for (const line of parts) if (line.trim()) this.#onLine(line);
  }

  flush(): void {
    if (this.#partial.trim()) this.#onLine(this.#partial);
    this.#partial = '';
  }
}

interface ExecError {
  readonly code?: unknown;
  readonly killed?: unknown;
  readonly signal?: unknown;
}

function failureReason(error: unknown): { code: number | null; error: string | null } {
  const info: ExecError = typeof error === 'object' && error !== null ? error : {};
  // A numeric code means the program ran and exited non-zero: not a runner failure.
  if (typeof info.code === 'number') return { code: info.code, error: null };
  if (info.killed === true) return { code: null, error: 'ETIMEDOUT' };
  if (typeof info.code === 'string') return { code: null, error: info.code };
  return { code: null, error: typeof info.signal === 'string' ? info.signal : 'EFAILED' };
}

export class ExecFileCancellableRunner implements CancellableCommandRunner {
  run(file: string, args: readonly string[], options: CancellableCommandOptions): Promise<CommandResult> {
    // Never start a child for an operation that is already cancelled.
    if (options.signal.aborted) return Promise.resolve({ stdout: '', stderr: '', code: null, error: ABORTED });
    return new Promise((resolve) => {
      const splitters = options.onLine ? [new LineSplitter(options.onLine), new LineSplitter(options.onLine)] : [];
      const done = (error: unknown, stdout: string, stderr: string): void => {
        for (const splitter of splitters) splitter.flush();
        resolve({ stdout, stderr, ...(error ? failureReason(error) : { code: 0, error: null }) });
      };
      try {
        const child = execFile(
          file,
          [...args],
          {
            encoding: 'utf8',
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
            signal: options.signal,
            windowsHide: true,
            shell: false,
            ...(options.env ? { env: { ...options.env } } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {})
          },
          (error, stdout, stderr) => done(error, String(stdout), String(stderr))
        );
        // execFile already decodes both streams as UTF-8 (chunks are strings).
        const [out, err] = splitters;
        if (out && err) {
          child.stdout?.on('data', (chunk: string) => out.push(chunk));
          child.stderr?.on('data', (chunk: string) => err.push(chunk));
        }
      } catch (error) {
        // execFile throws synchronously for invalid arguments (e.g. NUL bytes).
        done(error, '', '');
      }
    });
  }
}
