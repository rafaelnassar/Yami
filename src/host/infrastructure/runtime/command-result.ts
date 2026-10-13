/** Reading `CommandResult`s of the process module's runners (probes, pip, archivers). */
import type { CommandResult } from '../process/command-runner.ts';

export function succeeded(result: CommandResult): boolean {
  return result.code === 0 && result.error === null;
}

/** First non-empty line of stdout (or stderr, for tools that print versions there). */
export function firstOutputLine(result: CommandResult): string | null {
  for (const text of [result.stdout, result.stderr]) {
    const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (line) return line.trim();
  }
  return null;
}
