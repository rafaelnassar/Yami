/**
 * Validation of yt-dlp `--cookies-from-browser` values:
 * `BROWSER[+KEYRING][:PROFILE][::CONTAINER]` (same grammar yt-dlp accepts).
 */

export const COOKIE_BROWSERS = [
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale'
] as const;
export type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

const KEYRINGS = ['basictext', 'gnomekeyring', 'kwallet', 'kwallet5', 'kwallet6'] as const;
const SPEC = /^(?<name>[^+:]+)(?:\+(?<keyring>[^:]+))?(?::(?!:)(?<profile>.+?))?(?:::(?<container>.+))?$/;
const MAX_SPEC_LENGTH = 512;

function isCookieBrowser(value: string): value is CookieBrowser {
  return (COOKIE_BROWSERS as readonly string[]).includes(value);
}

/**
 * Returns the normalized spec (browser and keyring lower-cased) or `null` when the
 * value is not something yt-dlp would accept. Control characters are rejected.
 */
export function normalizeBrowserCookieSpec(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (!value || value.length > MAX_SPEC_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const groups = SPEC.exec(value)?.groups;
  if (!groups) return null;
  const name = (groups['name'] ?? '').trim().toLowerCase();
  if (!isCookieBrowser(name)) return null;
  let spec: string = name;
  const keyring = groups['keyring']?.trim().toLowerCase();
  if (keyring !== undefined) {
    if (!(KEYRINGS as readonly string[]).includes(keyring)) return null;
    spec += `+${keyring}`;
  }
  const profile = groups['profile']?.trim();
  if (profile) spec += `:${profile}`;
  const container = groups['container']?.trim();
  if (container) spec += `::${container}`;
  return spec;
}
