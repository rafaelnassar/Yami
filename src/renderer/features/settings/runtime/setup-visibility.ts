/** When the first-run setup wizard is shown (pure). */
import type { RuntimeStatusDto } from '../../../../shared/contracts/dto.ts';

export interface SetupVisibilityInput {
  readonly runtime: RuntimeStatusDto | null;
  readonly hostReady: boolean;
  readonly settingsOpen: boolean;
  readonly dismissedThisSession: boolean;
  /** The wizard is already open (keeps it open through "done"). */
  readonly open: boolean;
}

/**
 * Shown while an install runs (host auto-install or ours) or when tools are
 * missing and setup was not dismissed. Update/check operations never open it.
 */
export function shouldShowSetup(input: SetupVisibilityInput): boolean {
  const { runtime } = input;
  if (!input.hostReady || !runtime || input.settingsOpen) return false;
  if (input.open) return true;
  if (runtime.busy && runtime.operation?.kind === 'install') return true;
  return runtime.setupNeeded && !runtime.setupDismissed && !input.dismissedThisSession;
}
