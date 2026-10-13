/**
 * Engine-agnostic interpretation of one line of engine output.
 * Produced by engine parsers (infrastructure) and consumed by the downloads
 * domain. Pure data.
 */
import type { LogLevel } from '../../../shared/domain/log.ts';

/** Classified engine errors. `unknown` = an error line we could not classify. */
export const ENGINE_ERROR_KINDS = [
  'cookie-copy',
  'cookies-auth',
  'pixiv-auth',
  'login-required',
  'rate-limited',
  'unsupported-url',
  'not-found',
  'private',
  'geo-blocked',
  'network',
  'unknown'
] as const;

export type EngineErrorKind = (typeof ENGINE_ERROR_KINDS)[number];

export type ParsedLine =
  /** Progress chatter and blank lines — not shown, not counted. */
  | { readonly kind: 'noise' }
  /** Informational line worth showing in the log view. */
  | { readonly kind: 'info'; readonly level: LogLevel; readonly text: string }
  /** Download progress of the current file (yt-dlp). */
  | {
      readonly kind: 'progress';
      readonly percent: number | null;
      readonly speed: string | null;
      readonly eta: string | null;
    }
  /** A final media file was written (`downloaded`) or already existed (`skipped`). */
  | { readonly kind: 'file'; readonly status: 'downloaded' | 'skipped'; readonly path: string; readonly text: string }
  /** yt-dlp announced a destination that is not final yet (merge/move pending). */
  | { readonly kind: 'pending-file'; readonly path: string; readonly text: string }
  /** yt-dlp finished post-processing: the pending destination is now final. */
  | { readonly kind: 'promote-pending'; readonly text: string }
  /** An error reported by the engine. `fatal` = the whole item failed (not a warning). */
  | {
      readonly kind: 'error';
      readonly errorKind: EngineErrorKind;
      readonly message: string;
      readonly fatal: boolean;
      readonly text: string;
    };
