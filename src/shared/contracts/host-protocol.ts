/**
 * Host protocol — the contract between the Electron main process and the
 * download host (an Electron `utilityProcess`).
 *
 * Transport: `MessagePort` (structured clone). Every message is an `Envelope`.
 *   main → host : { kind: 'request', id, command, payload }
 *   host → main : { kind: 'response', id, ok, data | error }
 *                 { kind: 'event', event }
 *
 * Adding a command = add it to `HostCommands` + `COMMAND_SPECS`. The type system
 * forces both to stay in sync.
 *
 * This file is a stable barrel; implementation lives in `host-command-*.ts` /
 * `host-events.ts`.
 */
export { LIMITS, Schemas } from './host-command-schemas.ts';
export {
  MAIN_ONLY_COMMANDS,
  type CommandAudience,
  type CommandPayload,
  type CommandResult,
  type CookiesSnapshot,
  type DeleteFilesResult,
  type HostCommand,
  type HostCommands,
  type MainOnlyCommand,
  type RendererHostCommand,
  type RuntimeOperationStarted,
  type StartResult
} from './host-commands.ts';
export {
  COMMAND_SPECS,
  HOST_COMMANDS,
  commandAudience,
  isHostCommand,
  isRendererCommand,
  type CommandSpec
} from './host-command-specs.ts';
export {
  RequestEnvelopeSchema,
  type ConversationChangeReason,
  type EventEnvelope,
  type HostEvent,
  type HostEventType,
  type HostToMainMessage,
  type MainToHostMessage,
  type RawRequestEnvelope,
  type ReadyEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope
} from './host-events.ts';
