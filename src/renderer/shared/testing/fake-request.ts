/**
 * Fake `HostRequest` for unit tests. Handlers are keyed by command; unknown
 * commands fail with `NOT_SUPPORTED`. Every call is recorded in `calls`.
 */
import type { CommandPayload, CommandResult, RendererHostCommand } from '../../../shared/contracts/host-protocol.ts';
import type { IpcResult } from '../../../shared/contracts/ipc.ts';
import type { HostRequest } from '../api/yami-client.ts';

export type FakeHandlers = {
  readonly [C in RendererHostCommand]?: (
    payload: CommandPayload<C>
  ) => IpcResult<CommandResult<C>> | Promise<IpcResult<CommandResult<C>>>;
};

export interface FakeRequest {
  readonly request: HostRequest;
  readonly calls: Array<{ readonly command: RendererHostCommand; readonly payload: unknown }>;
}

type LooseHandler = (payload: unknown) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export function createFakeRequest(handlers: FakeHandlers): FakeRequest {
  const calls: Array<{ readonly command: RendererHostCommand; readonly payload: unknown }> = [];
  const lookup = handlers as Readonly<Record<string, LooseHandler | undefined>>;
  const loose = async (command: RendererHostCommand, payload: unknown): Promise<IpcResult<unknown>> => {
    calls.push({ command, payload });
    const handler = lookup[command];
    if (!handler) return { ok: false, error: { code: 'NOT_SUPPORTED' } };
    return handler(payload);
  };
  // Documented test-only adapter: the loose implementation satisfies every command signature at runtime.
  const request = loose as unknown as HostRequest;
  return { request, calls };
}
