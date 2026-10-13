import { OAUTH_UI_SITES, vaultSitesForUrl, type VaultSiteId } from '../../../../shared/domain/oauth-sites.ts';
import type { SiteCredentials } from '../../../application/ports/secrets.ts';
import { isPixivAppUrl } from '../url-rules.ts';

function categoriesForVault(vaultId: VaultSiteId): readonly string[] {
  const site = OAUTH_UI_SITES.find((s) => s.vaultId === vaultId && s.id !== 'pixiv-novel');
  return site?.galleryDlCategories ?? [vaultId];
}

function extractorEntry(credentials: SiteCredentials): Record<string, string> | null {
  if (credentials.kind === 'refresh-token') {
    const token = credentials.refreshToken?.trim() ?? '';
    return token ? { 'refresh-token': token } : null;
  }
  if (credentials.kind === 'access-token') {
    const token = credentials.accessToken?.trim() ?? '';
    return token ? { 'access-token': token } : null;
  }
  if (credentials.kind === 'api-key') {
    const apiKey = credentials.apiKey?.trim() ?? '';
    const userId = credentials.userId?.trim() ?? '';
    if (!apiKey || !userId) return null;
    return { 'api-key': apiKey, 'user-id': userId };
  }
  if (credentials.kind !== 'oauth1') return null;
  const token = credentials.accessToken?.trim() ?? '';
  const secret = credentials.accessTokenSecret?.trim() ?? '';
  if (!token || !secret) return null;
  return { 'access-token': token, 'access-token-secret': secret };
}

/** Builds gallery-dl extractor secret JSON for the given URL and stored site credentials. */
export function buildGalleryDlSecretConfig(
  url: string,
  sites: ReadonlyMap<string, SiteCredentials>
): Record<string, unknown> | null {
  const vaultIds = vaultSitesForUrl(url);
  if (vaultIds.length === 0) return null;

  const extractor: Record<string, Record<string, string>> = {};
  for (const vaultId of vaultIds) {
    const credentials = sites.get(vaultId);
    if (!credentials) continue;
    const entry = extractorEntry(credentials);
    if (!entry) continue;
    for (const category of categoriesForVault(vaultId)) {
      extractor[category] = { ...extractor[category], ...entry };
    }
  }

  if (Object.keys(extractor).length === 0) return null;
  if (vaultIds.includes('pixiv') && !isPixivAppUrl(url)) {
    delete extractor.pixiv;
    delete extractor['pixiv-novel'];
    if (Object.keys(extractor).length === 0) return null;
  }
  return { extractor };
}
