/**
 * Site mark for conversation rows and headers.
 * Loads a favicon from Google's public service; falls back to the local letter chip on error.
 */
import { useEffect, useState } from 'react';
import { siteAvatar, siteFaviconUrl, siteLabel } from '../lib/site.ts';
import { cn } from '../lib/utils.ts';

export function SiteAvatar({
  sourceUrl,
  size = 18,
  className = ''
}: {
  sourceUrl: string;
  size?: number;
  className?: string;
}) {
  const host = siteLabel(sourceUrl);
  const { letter, color } = siteAvatar(host);
  const fontSize = Math.max(9, Math.round(size * 0.58));
  const faviconUrl = siteFaviconUrl(host, size * 2);
  const [showLetter, setShowLetter] = useState(!faviconUrl);

  useEffect(() => {
    setShowLetter(!faviconUrl);
  }, [faviconUrl, sourceUrl]);

  if (!showLetter && faviconUrl) {
    return (
      <img
        src={faviconUrl}
        alt=""
        width={size}
        height={size}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setShowLetter(true)}
        className={cn('inline-block shrink-0 rounded-[4px] bg-surface-2 object-cover', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={host || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] font-sans font-semibold leading-none tracking-tight text-[#0a0a09]',
        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]',
        className
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize
      }}
    >
      {letter}
    </span>
  );
}
