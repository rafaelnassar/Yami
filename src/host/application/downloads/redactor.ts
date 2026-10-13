/**
 * Redaction of every text the downloads core publishes or stores (engine lines,
 * error messages, command lines, URLs): secrets, URL query strings and private
 * directories (vault, job workspaces) never leave the host.
 */
import { redactSecrets } from '../../../shared/domain/redaction.ts';
import { baseName } from '../../../shared/domain/media.ts';

export class Redactor {
  readonly #sensitiveDirs: readonly string[];

  constructor(sensitiveDirs: readonly string[]) {
    this.#sensitiveDirs = sensitiveDirs.filter((dir) => dir.length > 0);
  }

  text(value: string): string {
    return redactSecrets(value, { sensitiveDirs: this.#sensitiveDirs }).trimEnd();
  }

  /** `> <exe basename> <args>` with arguments containing spaces quoted, then redacted. */
  commandLine(executable: string, args: readonly string[]): string {
    const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
    return this.text(`> ${baseName(executable)} ${quoted.join(' ')}`);
  }
}
