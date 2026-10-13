/** Renders the previewed media (image zoom, video player, audio) or a fallback. */
import { useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { MediaUrlDto } from '../../../shared/contracts/ipc.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { baseName } from '../../shared/lib/paths.ts';
import { Button } from '../../shared/ui/button.tsx';
import { AdultBlurScrim } from '../media/AdultBlurScrim.tsx';
import type { AdultBlur } from '../media/useAdultBlur.ts';
import type { MediaRef } from './preview-store.ts';
import { VideoPlayer } from './video/VideoPlayer.tsx';
import { ZoomableImage } from './ZoomableImage.tsx';

export function PreviewLoading() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-text-3" role="status">
      <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden />
      <span className="text-xs">{t.t('ui.preview.loading')}</span>
    </div>
  );
}

export function PreviewFallback({ message, onOpenExternally }: { message: string; onOpenExternally: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(event) => event.stopPropagation()}>
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-text-3">
        <span className="text-sm text-text-2">{t.t('ui.preview.unavailable')}</span>
        <span className="text-xs">{message}</span>
        <Button type="button" variant="secondary" onClick={onOpenExternally}>
          <ExternalLink strokeWidth={1.75} aria-hidden />
          {t.t('ui.preview.openExternally')}
        </Button>
      </div>
    </div>
  );
}

export interface PreviewContentProps {
  readonly file: MediaRef;
  readonly media: MediaUrlDto;
  readonly blur: AdultBlur;
  readonly reduceMotion: boolean;
  readonly onOpenExternally: () => void;
  readonly onClose: () => void;
  /**
   * The media element could not load `url`: a fresh URL may follow as a new `media`, otherwise
   * `onFinal` runs and the failure is shown (see `useMediaUrl`).
   */
  readonly onLoadError: (url: string, onFinal: () => void) => void;
}

export function PreviewContent({
  file,
  media,
  blur,
  reduceMotion,
  onOpenExternally,
  onClose,
  onLoadError
}: PreviewContentProps) {
  const t = useT();
  const [unsupported, setUnsupported] = useState<MessageKey | null>(null);
  useEffect(() => setUnsupported(null), [media.url]);
  const fail = (key: MessageKey): void => onLoadError(media.url, () => setUnsupported(key));

  if (unsupported) return <PreviewFallback message={t.t(unsupported)} onOpenExternally={onOpenExternally} />;

  if (file.mediaType === 'image') {
    return (
      <div className="relative min-h-0 flex-1 p-3 sm:p-4" onClick={(event) => event.stopPropagation()}>
        <div className={blur.blurred ? 'pointer-events-none h-full select-none blur-[22px]' : 'h-full'}>
          <ZoomableImage
            src={media.url}
            alt={media.name || file.name}
            reduceMotion={reduceMotion}
            onError={() => fail('ui.preview.imageUnsupported')}
            onRequestClose={onClose}
          />
        </div>
        {blur.blurred ? <AdultBlurScrim onReveal={blur.reveal} /> : null}
      </div>
    );
  }

  if (file.mediaType === 'video') {
    return (
      // Keyed by file: a new `src` for the same player is a refetched URL of this file (it resumes playback).
      <VideoPlayer
        key={file.path}
        src={media.url}
        fileName={media.name || file.name}
        blur={blur}
        onUnsupported={fail}
        onRequestClose={onClose}
      />
    );
  }

  if (file.mediaType === 'audio') {
    return (
      <div
        className="flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-3 text-text-3"
        onClick={onClose}
      >
        <span className="max-w-full truncate px-4 text-sm text-text-2">{baseName(media.name || file.name)}</span>
        <audio
          src={media.url}
          controls
          autoPlay
          onClick={(event) => event.stopPropagation()}
          onError={() => fail('ui.preview.audioUnsupported')}
          className="w-full max-w-md"
        />
      </div>
    );
  }

  return <PreviewFallback message={t.t('ui.preview.noInline')} onOpenExternally={onOpenExternally} />;
}
