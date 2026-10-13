/**
 * Runtime tool commands. Install/update/check start background operations in
 * the host; the returned `operationId` is tracked so the completion event can
 * be reported once, by the window that started it, and handed to the caller
 * (the setup wizard follows exactly that operation).
 */
import type { RuntimeOperationKind } from '../../../../shared/contracts/dto.ts';
import type { RuntimeOperationStarted } from '../../../../shared/contracts/host-protocol.ts';
import type { IpcResult } from '../../../../shared/contracts/ipc.ts';
import type { RuntimeMode, ToolId } from '../../../../shared/domain/engine.ts';
import type { AppErrorData } from '../../../../shared/kernel/errors.ts';
import type { HostRequest } from '../../../shared/api/yami-client.ts';
import type { HostStore } from '../../host/host-store.ts';
import { errorText, key, type NoticesStore } from '../../notices/notices-store.ts';
import type { FinishedOperation, RuntimeStore } from './runtime-store.ts';

/** Outcome of starting a background operation: its id (to follow its completion) or the refusal. */
export type RuntimeStart =
  { readonly ok: true; readonly operationId: string } | { readonly ok: false; readonly error: AppErrorData };

export interface RuntimeActions {
  install(mode: RuntimeMode): Promise<RuntimeStart>;
  update(tools?: readonly ToolId[]): Promise<RuntimeStart>;
  checkUpdates(): Promise<RuntimeStart>;
  setMode(mode: RuntimeMode): Promise<AppErrorData | null>;
  /** Persists "don't show the setup again"; failures are toasted and returned. */
  dismissSetup(): Promise<AppErrorData | null>;
  /** Toast for operations started by this window (called by the event router). */
  reportFinished(finished: FinishedOperation): void;
}

const FAIL_TITLES = {
  install: 'ui.runtime.installFail',
  update: 'ui.runtime.updateFail',
  'check-updates': 'ui.runtime.checkFail'
} as const;

const DONE_TITLES = {
  install: 'ui.runtime.installed',
  update: 'ui.runtime.updated',
  'check-updates': null
} as const;

export function createRuntimeActions(deps: {
  readonly request: HostRequest;
  readonly runtime: RuntimeStore;
  readonly host: HostStore;
  readonly notices: NoticesStore;
}): RuntimeActions {
  const toast = deps.notices.getState();

  const started = (kind: RuntimeOperationKind, result: IpcResult<RuntimeOperationStarted>): RuntimeStart => {
    if (!result.ok) {
      toast.push({ kind: 'error', title: key(FAIL_TITLES[kind]), message: errorText(result.error) });
      return { ok: false, error: result.error };
    }
    deps.runtime.getState().track(result.data.operationId, kind);
    return { ok: true, operationId: result.data.operationId };
  };

  return {
    install: async (mode) => started('install', await deps.request('runtime.install', { mode })),
    update: async (tools) =>
      started('update', await deps.request('runtime.update', tools && tools.length > 0 ? { tools: [...tools] } : {})),
    checkUpdates: async () => started('check-updates', await deps.request('runtime.checkUpdates', {})),
    async setMode(mode) {
      const result = await deps.request('runtime.setMode', { mode });
      if (!result.ok) {
        toast.push({ kind: 'error', title: key('ui.runtime.modeFail'), message: errorText(result.error) });
        return result.error;
      }
      deps.host.getState().receiveState(result.data.state);
      return null;
    },
    async dismissSetup() {
      const result = await deps.request('runtime.dismissSetup', {});
      if (!result.ok) {
        toast.push({ kind: 'error', title: key('ui.setup.dismissFail'), message: errorText(result.error) });
        return result.error;
      }
      deps.host.getState().receiveState(result.data.state);
      return null;
    },
    reportFinished(finished) {
      if (!finished.kind) return;
      if (!finished.ok) {
        toast.push({
          kind: 'error',
          title: key(FAIL_TITLES[finished.kind]),
          message: finished.error ? errorText(finished.error) : null
        });
        return;
      }
      const title = DONE_TITLES[finished.kind];
      if (title) toast.push({ kind: 'success', title: key(title) });
    }
  };
}
