/** Custom video player of the preview (native controls hidden). */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';
import { usePreview, useServices } from '../../../app/services-context.tsx';
import { useReducedMotion } from '../../../shared/hooks/useReducedMotion.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { AdultBlurScrim } from '../../media/AdultBlurScrim.tsx';
import type { AdultBlur } from '../../media/useAdultBlur.ts';
import { useControlsVisibility } from './useControlsVisibility.ts';
import { useVideoElement } from './useVideoElement.ts';
import { useVideoShortcuts } from './useVideoShortcuts.ts';
import { VideoControls } from './VideoControls.tsx';

export interface VideoPlayerProps {
  readonly src: string;
  readonly fileName: string;
  readonly blur: AdultBlur;
  /** Load error; the caller may answer with a fresh `src` of the same file, where playback resumes. */
  readonly onUnsupported: (key: MessageKey) => void;
  readonly onRequestClose: () => void;
}

export function VideoPlayer({ src, fileName, blur, onUnsupported, onRequestClose }: VideoPlayerProps) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const { preview } = useServices();
  const rememberedVolume = usePreview((state) => state.volume);
  const playerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const draggingRef = useRef(false);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [skipHint, setSkipHint] = useState<-1 | 1 | null>(null);
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled;

  const { state, commands } = useVideoElement(videoRef, {
    src,
    blurred: blur.blurred,
    rememberedVolume,
    draggingRef,
    rememberVolume: (volume) => preview.getState().rememberVolume(volume),
    onUnsupported
  });
  const controls = useControlsVisibility(!state.paused, blur.blurred);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = (): void => setFit({ w: stage.clientWidth, h: stage.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (skipHint === null) return;
    const timer = window.setTimeout(() => setSkipHint(null), reduceMotion ? 200 : 700);
    return () => window.clearTimeout(timer);
  }, [reduceMotion, skipHint]);

  const skipBy = useCallback(
    (seconds: number) => {
      commands.seekTo((videoRef.current?.currentTime ?? 0) + seconds);
      setSkipHint(seconds < 0 ? -1 : 1);
    },
    [commands]
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void playerRef.current?.requestFullscreen().catch(() => undefined);
  }, []);

  useVideoShortcuts({
    enabled: !blur.blurred,
    volume: state.volume,
    muted: state.muted,
    duration: state.duration,
    rememberedVolume,
    onEscape: () => {
      if (document.fullscreenElement !== playerRef.current) return false;
      void document.exitFullscreen().catch(() => undefined);
      return true;
    },
    togglePlayback: commands.togglePlayback,
    skipBy,
    setVolume: commands.setVolume,
    toggleMute: commands.toggleMute,
    toggleFullscreen,
    seekTo: commands.seekTo,
    reveal: controls.reveal
  });

  const chromeShown = !blur.blurred && (controls.visible || state.paused);
  const overlayPad = chromeShown ? 'pb-32' : '';

  return (
    <div
      ref={playerRef}
      className={`preview-video-player relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden ${chromeShown ? '' : 'cursor-none'}`}
      role="region"
      aria-label={t.t('ui.preview.player')}
      onPointerMove={controls.reveal}
      onMouseLeave={controls.leave}
    >
      <div
        ref={stageRef}
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-bg"
        onClick={() => !document.fullscreenElement && onRequestClose()}
      >
        <div
          className="relative inline-flex max-h-full max-w-full cursor-pointer"
          onClick={(event) => {
            event.stopPropagation();
            controls.reveal();
            commands.clickStage();
          }}
        >
          <video
            key={src}
            ref={videoRef}
            src={src}
            playsInline
            preload="metadata"
            disablePictureInPicture={!pipSupported}
            controls={false}
            style={{
              width: 'auto',
              height: 'auto',
              maxWidth: fit.w > 0 ? fit.w : '100%',
              maxHeight: fit.h > 0 ? fit.h : '100%'
            }}
            className={`block bg-bg object-contain outline-none ${blur.blurred ? 'blur-[22px]' : ''}`}
            aria-label={fileName}
          />
          {skipHint !== null ? (
            <span className={`pointer-events-none absolute inset-0 grid place-items-center ${overlayPad}`} aria-hidden>
              <span className="rounded-md border border-border-2 bg-surface/95 px-3 py-1.5 font-mono text-sm tabular-nums text-text shadow-panel">
                {skipHint < 0 ? t.t('ui.preview.skipHintBack') : t.t('ui.preview.skipHintForward')}
              </span>
            </span>
          ) : !blur.blurred && state.ready && state.paused ? (
            <span className={`pointer-events-none absolute inset-0 grid place-items-center ${overlayPad}`} aria-hidden>
              <span className="inline-flex size-16 items-center justify-center rounded-full border border-border-2 bg-surface/95 text-text shadow-panel">
                <Play className="ml-[3px] h-7 w-7" strokeWidth={2} />
              </span>
            </span>
          ) : null}
          {!blur.blurred && (!state.ready || (state.waiting && !state.paused)) ? (
            <span className={`pointer-events-none absolute inset-0 grid place-items-center ${overlayPad}`} aria-hidden>
              <Loader2 className="h-7 w-7 animate-spin text-text-3 motion-reduce:animate-none" strokeWidth={1.75} />
            </span>
          ) : null}
        </div>
        {blur.blurred ? <AdultBlurScrim onReveal={blur.reveal} /> : null}
      </div>
      {!blur.blurred ? (
        <div
          className={`absolute inset-x-0 bottom-0 z-20 ${chromeShown ? 'opacity-100' : 'pointer-events-none opacity-0'} ${reduceMotion ? '' : 'transition-opacity duration-200'}`}
          onClick={(event) => event.stopPropagation()}
          onMouseEnter={() => controls.hold('hover', true)}
          onMouseLeave={() => controls.hold('hover', false)}
        >
          <div className="pointer-events-none h-8 bg-gradient-to-t from-surface/90 to-transparent" />
          <VideoControls
            state={state}
            commands={commands}
            fullscreen={fullscreen}
            pipSupported={pipSupported}
            skipBy={skipBy}
            toggleFullscreen={toggleFullscreen}
            onDragChange={(dragging) => {
              draggingRef.current = dragging;
              controls.hold('drag', dragging);
            }}
            onMenuChange={(open) => controls.hold('menu', open)}
          />
        </div>
      ) : null}
    </div>
  );
}
