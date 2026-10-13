import { Progress } from './progress.tsx';

/** Determinate (percent) or indeterminate progress track — domain wrapper on shadcn Progress. */
export function ProgressTrack({
  percent,
  label,
  tone = 'ok'
}: {
  percent: number | null;
  label: string;
  tone?: 'ok' | 'neutral';
}) {
  return (
    <Progress
      value={percent ?? 0}
      indeterminate={percent === null}
      tone={tone}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    />
  );
}
