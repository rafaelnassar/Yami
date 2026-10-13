/**
 * Mirrors an HTMLVideoElement into React state (throttled time updates) and
 * exposes the playback commands. Autoplays muted; the first user play unmutes
 * with the remembered volume.
 *
 * After a load error the caller may hand the same player a fresh URL of the same
 * file (expired/revoked media token, see `useMediaUrl`): the new `src` then resumes
 * at the position, playing state and sound settings it failed at.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';

const TIME_UI_MS = 120;
const WAITING_DELAY_MS = 280;

export interface VideoState {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly ready: boolean;
  readonly waiting: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly bufferedEnd: number;
  readonly rate: number;
  readonly pipActive: boolean;
}

const INITIAL: VideoState = {
  paused: true,
  muted: true,
  volume: 1,
  ready: false,
  waiting: false,
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  rate: 1,
  pipActive: false
};

export interface VideoCommands {
  readonly togglePlayback: () => void;
  /** Click on the picture: first click on a muted autoplay unmutes, otherwise toggles playback. */
  readonly clickStage: () => void;
  readonly setVolume: (volume: number) => void;
  readonly toggleMute: () => void;
  readonly seekTo: (time: number) => void;
  readonly setRate: (rate: number) => void;
  readonly togglePip: () => void;
}

export interface VideoElementOptions {
  readonly src: string;
  readonly blurred: boolean;
  readonly rememberedVolume: number;
  readonly draggingRef: RefObject<boolean>;
  readonly rememberVolume: (volume: number) => void;
  /** The video failed to load; a fresh `src` for the same file may follow (playback then resumes). */
  readonly onUnsupported: (key: MessageKey) => void;
}

/** Where playback stood when the previous `src` failed. */
interface ResumePoint {
  readonly time: number;
  readonly playing: boolean;
  readonly soundTouched: boolean;
}

export function useVideoElement(
  videoRef: RefObject<HTMLVideoElement>,
  options: VideoElementOptions
): { state: VideoState; commands: VideoCommands } {
  const [state, setState] = useState<VideoState>(INITIAL);
  const userTouchedSound = useRef(false);
  const resumeRef = useRef<ResumePoint | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const patch = useCallback((next: Partial<VideoState>) => setState((current) => ({ ...current, ...next })), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Set by the error of the previous `src`: this one is a fresh URL of the same file (the player is keyed by file).
    const resume = resumeRef.current;
    resumeRef.current = null;
    setState(INITIAL);
    userTouchedSound.current = resume?.soundTouched ?? false;
    let active = true;
    // A resumed video keeps the user's sound settings: no muted autoplay.
    let autoplayed = resume !== null;
    let waitingTimer = 0;
    let lastTimeUi = 0;

    const sync = (): void => {
      if (!active) return;
      patch({
        paused: video.paused,
        muted: video.muted || video.volume === 0,
        volume: video.volume,
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        rate: video.playbackRate || 1,
        bufferedEnd: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0
      });
    };
    const onTime = (): void => {
      const now = performance.now();
      if (now - lastTimeUi < TIME_UI_MS && !video.paused && !optionsRef.current.draggingRef.current) return;
      lastTimeUi = now;
      if (active)
        patch({
          currentTime: video.currentTime,
          ...(Number.isFinite(video.duration) ? { duration: video.duration } : {})
        });
    };
    const onWaiting = (): void => {
      window.clearTimeout(waitingTimer);
      waitingTimer = window.setTimeout(() => active && patch({ waiting: true }), WAITING_DELAY_MS);
    };
    const onPlaying = (): void => {
      window.clearTimeout(waitingTimer);
      if (active) patch({ waiting: false, paused: false });
    };
    const onReady = (): void => {
      if (!active) return;
      patch({ ready: true, waiting: false });
      sync();
    };
    const tryAutoplay = (): void => {
      if (!active || autoplayed || optionsRef.current.blurred || userTouchedSound.current) return;
      autoplayed = true;
      video.muted = true;
      video.volume = optionsRef.current.rememberedVolume;
      void video.play().catch(() => active && patch({ paused: true }));
    };
    const onResume = (): void => {
      if (!active || !resume) return;
      video.currentTime = Number.isFinite(video.duration) ? Math.min(resume.time, video.duration) : resume.time;
      if (resume.playing) void video.play().catch(() => active && patch({ paused: true }));
    };
    const onError = (): void => {
      if (!active) return;
      resumeRef.current =
        video.currentTime > 0
          ? { time: video.currentTime, playing: !video.paused, soundTouched: userTouchedSound.current }
          : null;
      const code = video.error?.code ?? 0;
      optionsRef.current.onUnsupported(
        code === 3 || code === 4 ? 'ui.preview.videoUnsupported' : 'ui.preview.videoLoadFailed'
      );
    };
    const onPip = (): void => patch({ pipActive: document.pictureInPictureElement === video });

    const listeners: Array<[string, () => void]> = [
      ['play', sync],
      ['pause', sync],
      ['ended', sync],
      ['timeupdate', onTime],
      ['durationchange', sync],
      ['loadedmetadata', sync],
      ['loadedmetadata', onResume],
      ['progress', sync],
      ['volumechange', sync],
      ['ratechange', sync],
      ['waiting', onWaiting],
      ['playing', onPlaying],
      ['loadeddata', onReady],
      ['canplay', onReady],
      ['canplay', tryAutoplay],
      ['error', onError],
      ['enterpictureinpicture', onPip],
      ['leavepictureinpicture', onPip]
    ];
    for (const [name, handler] of listeners) video.addEventListener(name, handler);
    if (video.readyState >= 1) onResume();
    if (video.readyState >= 2) onReady();
    if (video.readyState >= 3) tryAutoplay();

    return () => {
      active = false;
      window.clearTimeout(waitingTimer);
      for (const [name, handler] of listeners) video.removeEventListener(name, handler);
      video.pause();
    };
  }, [options.src, patch, videoRef]);

  useEffect(() => {
    if (options.blurred) videoRef.current?.pause();
  }, [options.blurred, videoRef]);

  const commands: VideoCommands = {
    togglePlayback() {
      const video = videoRef.current;
      if (!video || optionsRef.current.blurred) return;
      if (!video.paused) {
        video.pause();
        return;
      }
      if (video.ended) video.currentTime = 0;
      if ((video.muted || video.volume === 0) && !userTouchedSound.current) {
        video.muted = false;
        video.volume = optionsRef.current.rememberedVolume || 1;
      }
      void video.play().catch(() => {
        video.muted = true;
        void video.play().catch(() => patch({ paused: true }));
      });
    },
    clickStage() {
      const video = videoRef.current;
      if (!video || optionsRef.current.blurred) return;
      if (!video.paused && (video.muted || video.volume === 0) && !userTouchedSound.current) {
        video.muted = false;
        video.volume = optionsRef.current.rememberedVolume || 1;
        return;
      }
      commands.togglePlayback();
    },
    setVolume(next) {
      const video = videoRef.current;
      const clamped = Math.min(1, Math.max(0, Number(next.toFixed(3))));
      userTouchedSound.current = true;
      optionsRef.current.rememberVolume(clamped);
      if (video) {
        video.volume = clamped;
        video.muted = clamped === 0;
      }
    },
    toggleMute() {
      const video = videoRef.current;
      if (!video || optionsRef.current.blurred) return;
      userTouchedSound.current = true;
      if (video.muted || video.volume === 0) {
        video.muted = false;
        video.volume = optionsRef.current.rememberedVolume || 1;
        return;
      }
      optionsRef.current.rememberVolume(video.volume);
      video.muted = true;
    },
    seekTo(time) {
      const video = videoRef.current;
      if (!video) return;
      const max = Number.isFinite(video.duration) ? video.duration : time;
      video.currentTime = Math.min(Math.max(0, time), max);
      patch({ currentTime: video.currentTime });
    },
    setRate(rate) {
      const video = videoRef.current;
      if (video) video.playbackRate = rate;
    },
    togglePip() {
      const video = videoRef.current;
      if (!video) return;
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined);
      else void video.requestPictureInPicture().catch(() => undefined);
    }
  };

  return { state, commands };
}
