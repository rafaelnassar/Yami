/**
 * `host:*` — forwards renderer commands to the host after validating the command name
 * (renderer audience only: privileged commands are never forwarded) and the payload
 * (`COMMAND_SPECS[command].schema`). The host validates again (defense in depth).
 */
import {
  COMMAND_SPECS,
  isHostCommand,
  isRendererCommand,
  type HostCommand
} from '../../../shared/contracts/host-protocol.ts';
import { IPC, IpcSchemas, type HostConnectionStatus, type IpcResult } from '../../../shared/contracts/ipc.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, type Result } from '../../../shared/kernel/result.ts';
import { parseArg, toIpcResult, type IpcRouter } from '../ipc-router.ts';

export interface HostControllerDeps {
  readonly forward: (command: HostCommand, payload: unknown) => Promise<Result<unknown, AppErrorData>>;
  readonly status: () => HostConnectionStatus;
  readonly restart: () => Result<null, AppErrorData>;
}

/** Validates a raw `host:request` argument into a forwardable command + payload. */
export function validateHostRequest(arg: unknown): Result<{ command: HostCommand; payload: unknown }, AppErrorData> {
  const request = parseArg(IpcSchemas.hostRequest, arg);
  if (!request.ok) return request;
  const { command, payload } = request.value;
  if (!isHostCommand(command)) return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'command' }));
  if (!isRendererCommand(command)) return err(appError(ErrorCode.IPC_UNAUTHORIZED));
  const parsed = COMMAND_SPECS[command].schema.parse(payload);
  if (!parsed.ok)
    return err(
      appError(ErrorCode.VALIDATION_FAILED, { path: parsed.error.path ? `payload.${parsed.error.path}` : 'payload' })
    );
  return { ok: true, value: { command, payload: parsed.value } };
}

export function registerHostController(router: IpcRouter, deps: HostControllerDeps): void {
  router.handleResult(IPC.host.request, async (_ctx, arg): Promise<IpcResult<unknown>> => {
    const request = validateHostRequest(arg);
    if (!request.ok) return toIpcResult(request);
    return toIpcResult(await deps.forward(request.value.command, request.value.payload));
  });
  router.handleValue(IPC.host.getStatus, () => deps.status());
  router.handleResult(IPC.host.restart, () => toIpcResult(deps.restart()));
}
