/**
 * Content-Security-Policy sent as a response header by the `app:` protocol (production).
 * Development adds the same policy to the Vite dev server's responses (`dev-csp.ts`).
 */
import { MEDIA_SCHEME } from './origins.ts';

export type CspDirectives = Readonly<Record<string, readonly string[]>>;

export const APP_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  // Site avatars: Google favicon service redirects to *.gstatic.com (domain-only query).
  'img-src': ["'self'", 'data:', `${MEDIA_SCHEME}:`, 'https://www.google.com', 'https://*.gstatic.com'],
  'media-src': ["'self'", `${MEDIA_SCHEME}:`],
  'connect-src': ["'self'"],
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'none'"]
};

/** No whitespace, `;` or `,`: a source can never smuggle in another directive/policy. `=` is base64 padding in hashes. */
const TOKEN = /^[\w'*:/.+=-]+$/;

/** Serializes directives; rejects tokens that could inject extra directives. */
export function buildCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => {
      if (!/^[a-z-]+$/.test(name)) throw new Error(`invalid CSP directive: ${name}`);
      for (const source of sources) {
        if (!TOKEN.test(source)) throw new Error(`invalid CSP source: ${source}`);
      }
      return sources.length > 0 ? `${name} ${sources.join(' ')}` : name;
    })
    .join('; ');
}

export const APP_CSP = buildCsp(APP_CSP_DIRECTIVES);
