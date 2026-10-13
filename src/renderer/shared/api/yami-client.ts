/**
 * Thin, typed wrapper around `window.yami` (the preload bridge).
 *
 * Every call resolves to `IpcResult<T>` — never rejects. Unexpected exceptions
 * (bridge missing, IPC crash) are normalized to `AppErrorData` so the UI always
 * has a `code` it can translate.
 */
import { ErrorCode, toAppErrorData, type AppErrorData } from '../../../shared/kernel/errors.ts';
import type { CommandPayload, CommandResult, RendererHostCommand } from '../../../shared/contracts/host-protocol.ts';
import type { IpcResult, YamiApi } from '../../../shared/contracts/ipc.ts';

export type HostRequest = <C extends RendererHostCommand>(
  command: C,
  payload: CommandPayload<C>
) => Promise<IpcResult<CommandResult<C>>>;

export interface YamiClient {
  readonly api: YamiApi;
  /** Sends a host command through main (sender + payload are validated there). */
  readonly request: HostRequest;
  /** Runs a bridge call that already returns `IpcResult`, catching unexpected throws. */
  call<T>(invoke: (api: YamiApi) => Promise<IpcResult<T>>): Promise<IpcResult<T>>;
  /** Runs a bridge call that returns a plain value, wrapping it in `IpcResult`. */
  value<T>(invoke: (api: YamiApi) => Promise<T>): Promise<IpcResult<T>>;
}

export function failure(error: AppErrorData): { readonly ok: false; readonly error: AppErrorData } {
  return { ok: false, error };
}

function normalizeResult<T>(result: unknown): IpcResult<T> {
  if (typeof result === 'object' && result !== null && 'ok' in result) {
    return result as IpcResult<T>;
  }
  return failure({ code: ErrorCode.INTERNAL, params: { detail: 'invalid-ipc-result' } });
}

export function createYamiClient(api: YamiApi): YamiClient {
  const call = async <T>(invoke: (bridge: YamiApi) => Promise<IpcResult<T>>): Promise<IpcResult<T>> => {
    try {
      return normalizeResult<T>(await invoke(api));
    } catch (error) {
      return failure(toAppErrorData(error));
    }
  };

  const value = async <T>(invoke: (bridge: YamiApi) => Promise<T>): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await invoke(api) };
    } catch (error) {
      return failure(toAppErrorData(error));
    }
  };

  const request: HostRequest = (command, payload) => call((bridge) => bridge.host.request(command, payload));

  return { api, request, call, value };
}
