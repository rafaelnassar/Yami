/**
 * Validates and dispatches request envelopes from main.
 * - Every payload is validated again with the command schema (defense in depth:
 *   main already validated renderer calls).
 * - Handlers return `Result`; thrown exceptions are bugs → `INTERNAL`, logged.
 * - The router never throws and always answers a well-formed request.
 */
import { AppError, ErrorCode, toAppErrorData, type AppErrorData } from '../../shared/kernel/errors.ts';
import type { Result } from '../../shared/kernel/result.ts';
import { formatIssue } from '../../shared/validation/schema.ts';
import {
  COMMAND_SPECS,
  RequestEnvelopeSchema,
  isHostCommand,
  type CommandPayload,
  type CommandResult,
  type HostCommand,
  type ResponseEnvelope
} from '../../shared/contracts/host-protocol.ts';
import type { Logger } from '../application/ports/system.ts';

export type CommandHandler<C extends HostCommand> = (
  payload: CommandPayload<C>
) => Result<CommandResult<C>, AppErrorData> | Promise<Result<CommandResult<C>, AppErrorData>>;

export type CommandHandlers = { readonly [C in HostCommand]: CommandHandler<C> };

/** Decides whether a command may run now (e.g. before configuration or during shutdown). */
export type CommandGate = (command: HostCommand) => AppErrorData | null;

export interface CommandRouterDeps {
  readonly handlers: () => Partial<CommandHandlers>;
  readonly gate: CommandGate;
  readonly logger: Logger;
  /** Called after a command succeeded (e.g. to schedule a state broadcast). */
  readonly onSuccess?: (command: HostCommand) => void;
}

export class CommandRouter {
  readonly #deps: CommandRouterDeps;

  constructor(deps: CommandRouterDeps) {
    this.#deps = deps;
  }

  /** Returns the response to send, or `null` when the message is not a request at all. */
  async handle(raw: unknown): Promise<ResponseEnvelope | null> {
    const envelope = RequestEnvelopeSchema.parse(raw);
    if (!envelope.ok) {
      this.#deps.logger.warn('dropped malformed message', { reason: formatIssue(envelope.error) });
      return null;
    }
    const { id, command, payload } = envelope.value;
    const error = (data: AppErrorData): ResponseEnvelope => ({ kind: 'response', id, ok: false, error: data });

    if (!isHostCommand(command)) return error({ code: ErrorCode.VALIDATION_FAILED, params: { path: 'command' } });
    const blocked = this.#deps.gate(command);
    if (blocked) return error(blocked);

    const parsed = COMMAND_SPECS[command].schema.parse(payload);
    if (!parsed.ok) {
      return error({ code: ErrorCode.VALIDATION_FAILED, params: { path: parsed.error.path || 'payload' } });
    }

    const handler = this.#deps.handlers()[command] as CommandHandler<HostCommand> | undefined;
    if (!handler) return error({ code: ErrorCode.HOST_UNAVAILABLE });

    try {
      const result = await handler(parsed.value);
      if (!result.ok) return error(result.error);
      this.#deps.onSuccess?.(command);
      return { kind: 'response', id, ok: true, data: result.value };
    } catch (thrown) {
      const data = thrown instanceof AppError ? thrown.toData() : toAppErrorData(thrown);
      this.#deps.logger.error('command failed', {
        command,
        error: thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)
      });
      return error(data);
    }
  }
}
