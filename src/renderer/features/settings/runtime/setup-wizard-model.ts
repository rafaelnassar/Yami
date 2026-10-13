/**
 * Step machine of the first-run setup wizard (pure).
 *
 * The wizard follows exactly ONE install operation: the one it started (id
 * returned by `runtime.install`) or a host auto-install it adopted. Completion
 * events of any other operation — a previous failed attempt, an update check —
 * are ignored, so Retry never shows a stale failure and a stale success never
 * jumps to "done".
 */
import type { RuntimeOperationKind } from '../../../../shared/contracts/dto.ts';
import type { RuntimeMode } from '../../../../shared/domain/engine.ts';
import { ErrorCode, type AppErrorData } from '../../../../shared/kernel/errors.ts';

export type SetupStep = 'choose' | 'working' | 'done' | 'error';

export interface SetupWizardState {
  readonly step: SetupStep;
  readonly mode: RuntimeMode;
  /** Install operation being followed; `null` while the start request is in flight. */
  readonly operationId: string | null;
  readonly error: AppErrorData | null;
}

export type SetupWizardEvent =
  | { readonly type: 'start'; readonly mode: RuntimeMode }
  | { readonly type: 'started'; readonly operationId: string }
  | { readonly type: 'startFailed'; readonly error: AppErrorData; readonly hostInstallId: string | null }
  /** The host reports an install in flight (auto-install or started by another window). */
  | { readonly type: 'hostInstall'; readonly operationId: string }
  | {
      readonly type: 'finished';
      readonly operationId: string;
      readonly ok: boolean;
      readonly error: AppErrorData | null;
      /** Kind when the operation was started by this window, `null` otherwise. */
      readonly kind: RuntimeOperationKind | null;
    }
  | { readonly type: 'retry' };

export function initialSetupState(hostInstallId: string | null): SetupWizardState {
  return hostInstallId
    ? { step: 'working', mode: 'standalone', operationId: hostInstallId, error: null }
    : { step: 'choose', mode: 'standalone', operationId: null, error: null };
}

export function setupReducer(state: SetupWizardState, event: SetupWizardEvent): SetupWizardState {
  switch (event.type) {
    case 'start':
      return { step: 'working', mode: event.mode, operationId: null, error: null };
    case 'started':
      return state.step === 'working' && state.operationId === null
        ? { ...state, operationId: event.operationId }
        : state;
    case 'startFailed':
      if (state.step !== 'working') return state;
      if (event.error.code === ErrorCode.TOOLS_BUSY) {
        // Another install is already running: follow it instead of failing.
        if (state.operationId !== null) return state;
        if (event.hostInstallId) return { ...state, operationId: event.hostInstallId };
      }
      return { ...state, step: 'error', operationId: null, error: event.error };
    case 'hostInstall':
      if (state.step === 'choose' || (state.step === 'working' && state.operationId === null)) {
        return { ...state, step: 'working', operationId: event.operationId, error: null };
      }
      return state;
    case 'finished':
      if (state.step !== 'working' || state.operationId === null || event.operationId !== state.operationId)
        return state;
      if (event.kind !== null && event.kind !== 'install') return state;
      return event.ok ? { ...state, step: 'done', error: null } : { ...state, step: 'error', error: event.error };
    case 'retry':
      return { ...state, step: 'choose', operationId: null, error: null };
  }
}
