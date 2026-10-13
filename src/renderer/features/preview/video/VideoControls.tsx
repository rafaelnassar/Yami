/** Bottom chrome of the video player: seek bar, play/skip, volume, speed, PiP, fullscreen. */
import {
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX
} from 'lucide-react';
import { formatMediaTime } from '../../../shared/i18n/format.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { MenuButton } from '../../../shared/ui/Menu.tsx';
import { MediaSlider, SKIP_SECONDS } from './MediaSlider.tsx';
import type { VideoCommands, VideoState } from './useVideoElement.ts';

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const CLUSTER = 'inline-flex h-9 shrink-0 items-center gap-0.5 rounded-md border border-border bg-input/80 px-0.5';

export interface VideoControlsProps {
  readonly state: VideoState;
  readonly commands: VideoCommands;
  readonly fullscreen: boolean;
  readonly pipSupported: boolean;
  readonly skipBy: (seconds: number) => void;
  readonly toggleFullscreen: () => void;
  readonly onDragChange: (dragging: boolean) => void;
  readonly onMenuChange: (open: boolean) => void;
}

const formatRate = (rate: number): string => `${rate}×`;

export function VideoControls({
  state,
  commands,
  fullscreen,
  pipSupported,
  skipBy,
  toggleFullscreen,
  onDragChange,
  onMenuChange
}: VideoControlsProps) {
  const t = useT();
  const long = state.duration >= 3600;
  const VolumeIcon = state.muted || state.volume === 0 ? VolumeX : state.volume < 0.4 ? Volume1 : Volume2;

  return (
    <div className="border-t border-border bg-surface/95 px-4 py-2.5 md:px-5">
      <div className="flex items-center gap-3">
        <span
          className={`shrink-0 text-right font-mono text-xs tabular-nums leading-none text-text ${long ? 'w-[8ch]' : 'w-[5ch]'}`}
        >
          {formatMediaTime(state.currentTime, true)}
        </span>
        <MediaSlider
          kind="seek"
          value={state.currentTime}
          max={state.duration}
          buffered={state.bufferedEnd}
          onChange={commands.seekTo}
          onDragChange={onDragChange}
          label={t.t('ui.preview.seek')}
          valueText={formatMediaTime(state.currentTime, true)}
        />
        <span
          className={`shrink-0 font-mono text-xs tabular-nums leading-none text-text-3 ${long ? 'w-[8ch]' : 'w-[5ch]'}`}
        >
          {formatMediaTime(state.duration, true)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className={CLUSTER}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={commands.togglePlayback}
            aria-label={state.paused ? t.t('ui.preview.play') : t.t('ui.preview.pause')}
            title={state.paused ? t.t('ui.preview.play') : t.t('ui.preview.pause')}
          >
            {state.paused ? (
              <Play className="ml-[1.5px]" strokeWidth={1.75} aria-hidden />
            ) : (
              <Pause strokeWidth={1.75} aria-hidden />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => skipBy(-SKIP_SECONDS)}
            aria-label={t.t('ui.preview.skipBack')}
            title={t.t('ui.preview.skipBack')}
          >
            <SkipBack strokeWidth={1.75} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => skipBy(SKIP_SECONDS)}
            aria-label={t.t('ui.preview.skipForward')}
            title={t.t('ui.preview.skipForward')}
          >
            <SkipForward strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
        <div className="inline-flex h-10 shrink-0 items-center gap-0.5 rounded-md border border-border bg-input/80 pl-0.5 pr-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={commands.toggleMute}
            aria-label={state.muted ? t.t('ui.preview.unmute') : t.t('ui.preview.mute')}
            title={state.muted ? t.t('ui.preview.unmute') : t.t('ui.preview.mute')}
          >
            <VolumeIcon strokeWidth={1.75} aria-hidden />
          </Button>
          <MediaSlider
            kind="volume"
            value={state.muted ? 0 : state.volume}
            max={1}
            onChange={commands.setVolume}
            onDragChange={onDragChange}
            label={t.t('ui.preview.volume')}
            valueText={`${Math.round((state.muted ? 0 : state.volume) * 100)}%`}
            className="w-28"
          />
        </div>
        <div className="ml-auto flex h-10 items-center gap-2">
          <MenuButton
            menuLabel={t.t('ui.preview.speed')}
            triggerLabel={`${t.t('ui.preview.speed')}: ${formatRate(state.rate)}`}
            title={t.t('ui.preview.speed')}
            width={120}
            onOpenChange={onMenuChange}
            triggerSize="sm"
            triggerVariant="secondary"
            triggerClassName="min-w-10 shrink-0 font-mono tabular-nums leading-none"
            triggerContent={formatRate(state.rate)}
            items={PLAYBACK_RATES.map((rate) => ({
              id: String(rate),
              kind: 'radio' as const,
              checked: state.rate === rate,
              label: formatRate(rate),
              onSelect: () => commands.setRate(rate)
            }))}
          />
          {pipSupported ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={commands.togglePip}
              aria-label={t.t('ui.preview.pip')}
              title={t.t('ui.preview.pip')}
              aria-pressed={state.pipActive}
            >
              <PictureInPicture2 strokeWidth={1.75} aria-hidden />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? t.t('ui.preview.exitFullscreen') : t.t('ui.preview.fullscreen')}
            title={fullscreen ? t.t('ui.preview.exitFullscreen') : t.t('ui.preview.fullscreen')}
          >
            {fullscreen ? <Minimize strokeWidth={1.75} aria-hidden /> : <Maximize strokeWidth={1.75} aria-hidden />}
          </Button>
        </div>
      </div>
    </div>
  );
}
