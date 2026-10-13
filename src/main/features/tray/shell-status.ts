/** Pure mapping of host status/state to the tray tooltip and the taskbar progress bar. */
import type { HostStateDto } from '../../../shared/contracts/dto.ts';
import type { HostConnectionStatus } from '../../../shared/contracts/ipc.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import type { Translator } from '../../../shared/i18n/translator.ts';

/** The part of the host state the OS shell integrations look at. */
export type ShellState = Pick<HostStateDto, 'status' | 'downloads'>;

export function trayTooltip(status: HostConnectionStatus, state: ShellState | null, t: Translator<MessageKey>): string {
  switch (status.state) {
    case 'starting':
      return t.t('main.tray.tooltip.starting');
    case 'restarting':
      return t.t('main.tray.tooltip.restarting');
    case 'offline':
      return t.t('main.tray.tooltip.offline');
    case 'ready':
      break;
  }
  if (state?.status === 'running')
    return t.t('main.tray.tooltip.running', { count: Math.max(1, state.downloads.active.length) });
  if (state?.status === 'paused') return t.t('main.tray.tooltip.paused');
  return t.t('main.tray.tooltip.idle');
}

export interface TaskbarProgress {
  /** 0..1, or -1 to remove the bar. */
  readonly value: number;
  readonly mode: 'none' | 'normal' | 'indeterminate' | 'paused';
}

const NONE: TaskbarProgress = { value: -1, mode: 'none' };

function fraction(done: number, total: number): number | null {
  return total > 0 ? Math.min(1, Math.max(0, done / total)) : null;
}

/** Batch progress → single download percent → indeterminate; paused keeps the bar paused. */
export function taskbarProgress(state: ShellState | null): TaskbarProgress {
  if (!state || state.status === 'idle') return NONE;
  const batch = state.downloads.batch;
  const single = state.downloads.active.length === 1 ? state.downloads.active[0] : undefined;
  const value =
    (batch ? fraction(batch.finished, batch.total) : null) ??
    (single && single.percent !== null ? Math.min(1, Math.max(0, single.percent / 100)) : null);
  if (state.status === 'paused') return { value: value ?? 1, mode: 'paused' };
  return value === null ? { value: 1, mode: 'indeterminate' } : { value, mode: 'normal' };
}
