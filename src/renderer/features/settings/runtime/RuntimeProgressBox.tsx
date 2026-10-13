/** Progress of the current runtime operation (`runtime.progress`). */
import type { RuntimeProgressDto } from '../../../../shared/contracts/dto.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { formatRuntimeProgress } from '../../../shared/i18n/text.ts';
import { ProgressTrack } from '../../../shared/ui/progress-track.tsx';
import { Spinner } from '../../../shared/ui/spinner.tsx';
import { TOOL_LABELS } from '../../notices/toast-text.ts';

export function RuntimeProgressBox({ progress, working }: { progress: RuntimeProgressDto; working: boolean }) {
  const t = useT();
  const label = progress.tool ? TOOL_LABELS[progress.tool] : '';
  const step =
    progress.step !== null && progress.totalSteps !== null
      ? t.t('ui.runtime.progress.step', { step: progress.step, total: progress.totalSteps })
      : '';
  const title = [label, step].filter(Boolean).join(' · ') || t.t('ui.runtime.progress.working');
  const detail = formatRuntimeProgress(t, progress);
  const failed = progress.phase === 'error';

  return (
    <div
      className={`min-h-[4.75rem] space-y-2 rounded-md border px-3.5 py-3 ${failed ? 'border-err/30 bg-err/[0.06]' : 'border-border bg-surface/80'}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="type-label m-0 text-text">{title}</p>
          <p className={`type-caption m-0 mt-0.5 truncate ${failed ? 'text-err' : ''}`} title={detail}>
            {detail}
          </p>
        </div>
        {progress.percent !== null ? (
          <p className="type-caption m-0 shrink-0 tabular-nums text-text-2">{Math.round(progress.percent)}%</p>
        ) : working ? (
          <Spinner className="shrink-0 text-text-3" />
        ) : null}
      </div>
      <ProgressTrack percent={progress.percent} label={detail} />
    </div>
  );
}
