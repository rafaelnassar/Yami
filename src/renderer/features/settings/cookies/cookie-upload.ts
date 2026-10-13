/**
 * Pre-checks a picked cookie file before reading it (pure). The host validates
 * again; this only turns predictable refusals into clear, specific messages.
 */
import { LIMITS, Schemas } from '../../../../shared/contracts/host-protocol.ts';

export type CookieUploadProblem = 'extension' | 'name' | 'size' | 'empty';

export function cookieUploadProblem(file: {
  readonly name: string;
  readonly size: number;
}): CookieUploadProblem | null {
  if (!file.name.toLowerCase().endsWith('.txt')) return 'extension';
  // Same rule the host applies to cookie file names (`cookieRef`).
  if (!Schemas.cookieRef.parse({ name: file.name }).ok) return 'name';
  if (file.size > LIMITS.maxCookieFileBytes) return 'size';
  if (file.size === 0) return 'empty';
  return null;
}
