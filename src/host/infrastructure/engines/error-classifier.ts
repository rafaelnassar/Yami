/**
 * Classifies raw (English) engine error messages into `EngineErrorKind`.
 *
 * Classification runs on the raw engine text only; translation happens in the UI
 * from the kind (spec 03 Q12), so the legacy Portuguese alternatives are gone.
 * Rules are ordered: the first match wins.
 */
import type { EngineErrorKind } from '../../domain/engines/parsed-line.ts';

export interface ErrorSourceHint {
  /** Extractor/category that reported the error (`youtube`, `pixiv`…), when known. */
  readonly source?: string | null;
}

/** yt-dlp could not read the browser cookie store (Chrome locks it while open, yt-dlp#7271). */
const COOKIE_COPY = /could not copy .*cookie database|cookie database|issues\/7271/i;
/** Legacy pixiv-auth regex, extended with the newer gallery-dl wording. */
const AUTH_FAILURE =
  /AuthenticationError|AuthRequired|Authentication failed|refresh-token['"]?\s+(?:required|needed)|Invalid refresh token/i;
/**
 * YouTube bot check / age gate — browser cookies usually fix these. The wording alone
 * proves nothing (any site can put it in a page or an HTTP reason phrase), so it only
 * counts with a YouTube extractor tag.
 */
const YOUTUBE_SIGN_IN = /not a bot|sign in to confirm/i;
const COOKIES_FROM_BROWSER_HINT = /cookies-from-browser/i;
const PRIVATE =
  /private video|\bis private\b|private (?:account|profile|post|playlist)|members[- ]only|channel'?s members/i;
const GEO_BLOCKED = /available (?:in|from) your (?:country|region|location)|geo[- ]?(?:restrict|block)/i;
const LOGIN_REQUIRED =
  /log(?:ged)?[- ]?in (?:is )?required|requires? (?:a |an )?(?:log[- ]?in|account|authentication|sign[- ]?in)|sign[- ]?in required|registered users|authentication required|account credentials|\b401\b|unauthori[sz]ed|--cookies(?![\w-])|--username/i;
const RATE_LIMITED = /\b429\b|too many requests|rate[- ]?limit/i;
const UNSUPPORTED_URL = /unsupported url|no suitable extractor/i;
/** "ffmpeg not found" is a missing tool, not missing content. */
const NOT_FOUND =
  /\b404\b|does not exist|(?<!(?:ffmpeg|ffprobe|deno|executable|command)(?: is)? )not found|no longer available|has been removed|been deleted/i;
const NETWORK =
  /timed? ?out|connection (?:reset|refused|aborted|closed)|getaddrinfo|name or service not known|temporary failure in name resolution|nodename nor servname|network is unreachable|no route to host|\bssl|certificate verify failed|remote end closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|WinError 100(?:54|60|61)|Errno 1100[14]/i;

const SOURCE_TAG = /^\[([^\]\s]+)\]/;
/** yt-dlp YouTube extractors: `youtube`, `youtube:tab`, `youtube:playlist`… */
const YOUTUBE_SOURCE = /^youtube(?::|$)/i;

/** Extractor tag at the start of a yt-dlp message (`[youtube] id: …` → `youtube`), or `null`. */
export function sourceTagOf(message: string): string | null {
  return SOURCE_TAG.exec(message.trim())?.[1] ?? null;
}

function isYouTubeSource(source: string | null): boolean {
  return source !== null && YOUTUBE_SOURCE.test(source);
}

export function classifyEngineError(message: string, hint: ErrorSourceHint = {}): EngineErrorKind {
  const text = message.trim();
  const source = hint.source ?? sourceTagOf(text);
  if (COOKIE_COPY.test(text)) return 'cookie-copy';
  if (AUTH_FAILURE.test(text)) {
    // Without a known source keep the legacy behaviour (these messages came from Pixiv).
    const pixiv = source === null || /^pixiv/i.test(source) || /pixiv/i.test(text);
    return pixiv ? 'pixiv-auth' : 'login-required';
  }
  // `cookies-auth` may trigger a browser-cookie retry: never grant it on untagged or other-site text.
  if (YOUTUBE_SIGN_IN.test(text) && isYouTubeSource(source)) return 'cookies-auth';
  if (PRIVATE.test(text)) return 'private';
  if (GEO_BLOCKED.test(text)) return 'geo-blocked';
  // yt-dlp suggests --cookies-from-browser for every login wall; only YouTube's is a cookies-auth case (Q11).
  if (COOKIES_FROM_BROWSER_HINT.test(text)) return isYouTubeSource(source) ? 'cookies-auth' : 'login-required';
  if (LOGIN_REQUIRED.test(text)) return 'login-required';
  if (RATE_LIMITED.test(text)) return 'rate-limited';
  if (UNSUPPORTED_URL.test(text)) return 'unsupported-url';
  if (NOT_FOUND.test(text)) return 'not-found';
  if (NETWORK.test(text)) return 'network';
  return 'unknown';
}
