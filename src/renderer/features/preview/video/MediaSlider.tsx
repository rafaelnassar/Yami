/** Accessible slider (`role="slider"`) for seeking and volume, with pointer drag and keyboard steps. */
import { useEffect, useRef, type KeyboardEvent } from 'react';

export const VOLUME_STEP = 0.03;
export const VOLUME_STEP_FINE = 0.01;
export const SKIP_SECONDS = 10;

export interface MediaSliderProps {
  readonly value: number;
  readonly max: number;
  readonly buffered?: number;
  readonly label: string;
  readonly valueText: string;
  readonly kind: 'seek' | 'volume';
  readonly className?: string;
  readonly onChange: (next: number) => void;
  readonly onDragChange?: (dragging: boolean) => void;
}

export function MediaSlider({
  value,
  max,
  buffered = 0,
  label,
  valueText,
  kind,
  className = 'min-w-0 flex-1',
  onChange,
  onDragChange
}: MediaSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const bufferedRatio = max > 0 ? Math.min(1, Math.max(0, buffered / max)) : 0;
  const isVolume = kind === 'volume';

  const valueFromClientX = (clientX: number): number => {
    const element = trackRef.current;
    if (!element || max <= 0) return 0;
    const rect = element.getBoundingClientRect();
    const pad = 6;
    const ratioAt = (clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2);
    return Math.min(max, Math.max(0, ratioAt * max));
  };

  useEffect(() => {
    if (!isVolume) return;
    const element = trackRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const step = event.shiftKey ? VOLUME_STEP_FINE : VOLUME_STEP;
      onChangeRef.current(valueRef.current + (event.deltaY < 0 ? step : -step));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [isVolume]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const span = isVolume ? (event.shiftKey ? VOLUME_STEP_FINE : VOLUME_STEP) : event.shiftKey ? 1 : SKIP_SECONDS;
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? value - span
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? value + span
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next);
  };

  return (
    <div
      ref={trackRef}
      data-media-slider={kind}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={isVolume ? 100 : Math.round(max)}
      aria-valuenow={isVolume ? Math.round(ratio * 100) : Math.round(value)}
      aria-valuetext={valueText}
      className={`relative flex cursor-pointer items-center px-1.5 ${isVolume ? 'h-9' : 'h-8'} ${className}`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragChange?.(true);
        onChange(valueFromClientX(event.clientX));
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onChange(valueFromClientX(event.clientX));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        onDragChange?.(false);
      }}
      onPointerCancel={() => onDragChange?.(false)}
      onKeyDown={onKeyDown}
    >
      <div className="relative h-1.5 w-full rounded-full bg-border/80">
        {buffered > 0 ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-border-3"
            style={{ width: `${bufferedRatio * 100}%` }}
          />
        ) : null}
        <div className="absolute inset-y-0 left-0 rounded-full bg-text-2" style={{ width: `${ratio * 100}%` }} />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-3 bg-text"
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
