import type { OAuthCredentialKind } from '../../../shared/domain/oauth-sites.ts';

/** Token payload from a completed OAuth flow (main process only). */
export interface SiteOAuthResult {
  readonly kind: OAuthCredentialKind;
  readonly refreshToken?: string;
  readonly accessToken?: string;
  readonly accessTokenSecret?: string;
  readonly userName: string | null;
  readonly userId: string | null;
}
