/**
 * Adult-content blur policy (pure). One rule set shared by every place that
 * shows media: library, conversation workspace, preview and tray.
 *
 * Hints can be URLs, local paths or site/folder names; gallery-dl paths such as
 * `…/gallery-dl/rule34.xxx/…` are matched by treating separators as dots.
 */

const ADULT_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)rule34\./i,
  /(^|\.)e621\./i,
  /(^|\.)e926\./i,
  /danbooru\./i,
  /gelbooru\./i,
  /sankakucomplex\./i,
  /(^|\.)sankaku\./i,
  /(^|\.)nhentai\./i,
  /(^|\.)hentai/i,
  /(^|\.)pornhub\./i,
  /(^|\.)xvideos\./i,
  /(^|\.)xnxx\./i,
  /(^|\.)xhamster\./i,
  /(^|\.)fapello\./i,
  /(^|\.)coomer\./i,
  /(^|\.)kemono\./i,
  /(^|\.)xbooru\./i,
  /(^|\.)realbooru\./i,
  /(^|\.)hypnohub\./i,
  /(^|\.)tbib\./i,
  /(^|\.)exhentai\./i,
  /(^|\.)e-hentai\./i,
  /(^|\.)hitomi\./i,
  /(^|\.)erome\./i,
  /(^|\.)imagefap\./i,
  /(^|\.)redgifs\./i,
  /(^|\.)pornpics\./i,
  /(^|\.)8muses\./i,
  /(^|\.)sex\.com/i,
  /(^|\.)onlyfans\./i,
  /(^|\.)fansly\./i
];

/** Folder/site tokens (gallery-dl directory names) that identify adult sources. */
const ADULT_TOKENS: readonly string[] = [
  'rule34',
  'e621',
  'e926',
  'danbooru',
  'gelbooru',
  'sankaku',
  'nhentai',
  'hentai',
  'pornhub',
  'xvideos',
  'xnxx',
  'xhamster',
  'fapello',
  'coomer',
  'kemono',
  'xbooru',
  'realbooru',
  'hypnohub',
  'tbib',
  'exhentai',
  'e-hentai',
  'hitomi',
  'erome',
  'imagefap',
  'redgifs',
  'pornpics',
  '8muses',
  'onlyfans',
  'fansly'
];

function hostOf(hint: string): string | null {
  try {
    const url = new URL(hint);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when a URL, path or name points at a known adult source. */
export function isAdultHint(hint: string | null | undefined): boolean {
  if (!hint) return false;
  const host = hostOf(hint);
  if (host) return ADULT_HOST_PATTERNS.some((pattern) => pattern.test(host));

  const lower = hint.toLowerCase().replace(/\\/g, '/');
  const hostish = lower.replace(/\//g, '.');
  if (ADULT_HOST_PATTERNS.some((pattern) => pattern.test(lower) || pattern.test(hostish))) return true;

  const segments = lower.split(/[/._\s-]+/).filter(Boolean);
  return ADULT_TOKENS.some((token) => segments.some((segment) => segment === token || segment.startsWith(`${token}.`)));
}

/** The single blur decision: setting enabled and any hint is adult. */
export function shouldBlurMedia(enabled: boolean, hints: ReadonlyArray<string | null | undefined>): boolean {
  return enabled && hints.some((hint) => isAdultHint(hint));
}

/** Stable identity for a set of hints (resets "revealed" when the media changes). */
export function hintKey(hints: ReadonlyArray<string | null | undefined>): string {
  return hints.filter((hint): hint is string => Boolean(hint)).join('\n');
}

export const ADULT_BLUR_MEDIA_CLASS = 'scale-[1.06] blur-[18px]';
