/**
 * Test double for `CommandRunner` (used by unit tests of Windows/macOS branches
 * on any OS). Responses are matched by executable base name, in order.
 */
import type { CommandOptions, CommandResult, CommandRunner } from './command-runner.ts';

export interface RecordedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: CommandOptions;
}

type Responder = CommandResult | ((call: RecordedCommand) => CommandResult);

export function commandOk(stdout: string, code = 0): CommandResult {
  return { stdout, stderr: '', code, error: null };
}

export function commandFailed(error = 'ENOENT'): CommandResult {
  return { stdout: '', stderr: '', code: null, error };
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  readonly #responses = new Map<string, Responder[]>();

  /** Queues a response for the executable whose base name (lower-case) is `name`. */
  respond(name: string, response: Responder): this {
    const key = name.toLowerCase();
    const queue = this.#responses.get(key) ?? [];
    queue.push(response);
    this.#responses.set(key, queue);
    return this;
  }

  callsTo(name: string): RecordedCommand[] {
    return this.calls.filter((call) => baseName(call.file) === name.toLowerCase());
  }

  async run(file: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    const call: RecordedCommand = { file, args: [...args], options };
    this.calls.push(call);
    const queue = this.#responses.get(baseName(file));
    // The last response is sticky so polling code can call repeatedly.
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!next) return commandFailed('ENOENT');
    return typeof next === 'function' ? next(call) : next;
  }
}

function baseName(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return (index >= 0 ? file.slice(index + 1) : file).toLowerCase();
}
