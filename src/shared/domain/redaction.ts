/**
 * Removes secrets from free text before it is logged, stored or shown:
 * cookies/token arguments, sensitive query params, bearer tokens, URL query
 * strings/credentials and private paths (vault, job workspaces).
 */

export interface RedactionOptions {
  /** Absolute directories whose paths must never appear in output (vault, job workspaces). */
  readonly sensitiveDirs?: readonly string[];
}

const REDACTED = '[redacted]';

const ARG_WITH_SECRET =
  /(--(?:cookies|cookies-from-browser|password|username|netrc-location|video-password|ap-password|ap-username|add-header)\s+)("[^"]*"|'[^']*'|\S+)/gi;
const KEY_VALUE_SECRET =
  /\b((?:[\w.-]*\.)?(?:refresh[-_]token|access[-_]token|api[-_]?key|password|client[-_]secret|session(?:id)?|cookie))\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&"',;]+)/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL = /\bhttps?:\/\/[^\s"'<>]+/gi;

function stripUrl(raw: string): string {
  try {
    const url = new globalThis.URL(raw);
    const hadQuery = url.search.length > 1 || url.hash.length > 1;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return hadQuery ? `${url.toString()}?[redacted]` : url.toString();
  } catch {
    return raw.replace(/[?#].*$/, '?[redacted]');
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, options: RedactionOptions = {}): string {
  let out = text;
  for (const dir of options.sensitiveDirs ?? []) {
    if (!dir) continue;
    const variants = new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\//g, '\\')]);
    for (const variant of variants) {
      out = out.replace(new RegExp(`${escapeRegExp(variant)}[^\\s"']*`, 'gi'), '[private-path]');
    }
  }
  out = out.replace(ARG_WITH_SECRET, (_m, flag: string) => `${flag}${REDACTED}`);
  out = out.replace(KEY_VALUE_SECRET, (_m, key: string) => `${key}=${REDACTED}`);
  out = out.replace(BEARER, (_m, word: string) => `${word} ${REDACTED}`);
  out = out.replace(URL, (url) => stripUrl(url));
  return out;
}
