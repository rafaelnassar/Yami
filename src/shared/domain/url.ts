/** URL helpers shared by every process (pure). */

export function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(raw: string): boolean {
  return parseHttpUrl(raw) !== null;
}

/** Lower-cased hostname without a leading `www.`; `''` when not an http(s) URL. */
export function siteHostOf(raw: string): string {
  const url = parseHttpUrl(raw);
  if (!url) return '';
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** True when `host` equals `site` or is a subdomain of it. */
export function hostMatchesSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^\.+/, '');
  return h === s || h.endsWith(`.${s}`);
}

/** Removes query string and hash — used before logging/persisting URLs that may carry tokens. */
export function stripUrlSecrets(raw: string): string {
  const url = parseHttpUrl(raw);
  if (!url) return raw;
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}
