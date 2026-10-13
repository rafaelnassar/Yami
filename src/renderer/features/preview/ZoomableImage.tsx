/** Image preview with wheel zoom, double-click toggle and drag-to-pan when zoomed. */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { motion } from 'framer-motion';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { clampPan, zoomFromWheel } from './zoom-math.ts';

export interface ZoomableImageProps {
  readonly src: string;
  readonly alt: string;
  readonly reduceMotion: boolean;
  readonly onError: () => void;
  readonly onRequestClose: () => void;
}

export function ZoomableImage({ src, alt, reduceMotion, onError, onRequestClose }: ZoomableImageProps) {
  const t = useT();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [base, setBase] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastPointer = useRef({ x: 0, y: 0 });

  const measureBase = useCallback(() => {
    const img = imgRef.current;
    if (img && img.clientWidth > 0 && img.clientHeight > 0) setBase({ w: img.clientWidth, h: img.clientHeight });
  }, []);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [src]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom((value) => zoomFromWheel(value, event.deltaY));
    };
    const update = (): void => {
      setFit({ w: area.clientWidth, h: area.clientHeight });
      requestAnimationFrame(measureBase);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(area);
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      area.removeEventListener('wheel', onWheel);
    };
  }, [measureBase, src]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setPan((current) =>
      clampPan(current.x, current.y, zoom, viewport.clientWidth, viewport.clientHeight, base.w, base.h)
    );
  }, [base.h, base.w, zoom]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (zoom <= 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    lastPointer.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const viewport = viewportRef.current;
    if (!dragging || zoom <= 1 || !viewport) return;
    const dx = event.clientX - lastPointer.current.x;
    const dy = event.clientY - lastPointer.current.y;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    setPan((current) =>
      clampPan(
        current.x + dx / zoom,
        current.y + dy / zoom,
        zoom,
        viewport.clientWidth,
        viewport.clientHeight,
        base.w,
        base.h
      )
    );
  };

  const transition = reduceMotion || dragging ? 'none' : 'transform 150ms ease-out';
  const cursor = zoom > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in';

  return (
    <div
      ref={areaRef}
      className="relative flex h-full min-h-0 w-full min-w-0 cursor-pointer select-none items-center justify-center overflow-hidden"
      onClick={onRequestClose}
    >
      <div
        ref={viewportRef}
        className={`relative z-10 box-border max-h-full max-w-full overflow-hidden ${zoom > 1 ? 'touch-none' : ''} ${cursor}`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={(event: MouseEvent) => {
          event.preventDefault();
          setZoom((value) => (value > 1 ? 1 : 2));
        }}
        title={t.t('ui.preview.zoomHint')}
      >
        {zoom !== 1 ? (
          <span
            className="pointer-events-none absolute bottom-2 right-2 z-20 rounded-md border border-border/80 bg-bg/90 px-2 py-0.5 font-mono text-2xs tabular-nums text-text-2"
            aria-live="polite"
          >
            {Math.round(zoom * 100)}%
          </span>
        ) : null}
        <div
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition }}
          className="flex items-center justify-center"
        >
          <div
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`, transition }}
            className="flex items-center justify-center"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reduceMotion ? 0.01 : 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center justify-center"
            >
              <img
                ref={imgRef}
                src={src}
                alt={alt}
                draggable={false}
                onLoad={measureBase}
                onError={onError}
                style={{
                  width: 'auto',
                  height: 'auto',
                  maxWidth: fit.w > 0 ? fit.w : '100%',
                  maxHeight: fit.h > 0 ? fit.h : '100%'
                }}
                className="block object-contain outline-none"
              />
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
