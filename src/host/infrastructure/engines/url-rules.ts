/** URL predicates used to decide engine-specific behaviour (pure). */
import { parseHttpUrl } from '../../../shared/domain/url.ts';

function hostnameOf(url: string): string | null {
  const parsed = parseHttpUrl(url);
  return parsed ? parsed.hostname.toLowerCase().replace(/^www\./, '') : null;
}

/** Pixiv App API URLs (the ones gallery-dl authenticates with a refresh token). Pixiv Sketch is excluded. */
export function isPixivAppUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (host === null) return /(?:^|\/\/)(?:[\w-]+\.)?pixiv\.net\b/i.test(url) && !/sketch\.pixiv\.net/i.test(url);
  if (host === 'sketch.pixiv.net') return false;
  return host === 'pixiv.net' || host.endsWith('.pixiv.net');
}

/** YouTube hosts (used to scope YouTube-only error kinds and a future per-URL engine choice, spec 03 Q1). */
export function isYouTubeUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (host === null) return /(?:^|\.)youtu(?:\.be|be\.com)\b/i.test(url);
  return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
}
