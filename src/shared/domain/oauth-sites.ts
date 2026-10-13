/**
 * gallery-dl site account registry — vault keys, URL matching, gallery-dl extractor categories.
 * UI may show more rows than vault keys (e.g. pixiv-novel shares pixiv).
 */
import { hostMatchesSite, siteHostOf } from './url.ts';

/** Keys used in the encrypted credential store and `AccountsDto.sites`. */
export const VAULT_SITE_IDS = [
  'deviantart',
  'flickr',
  'gelbooru',
  'pixiv',
  'reddit',
  'smugmug',
  'tumblr',
  'mastodon.social',
  'pawoo',
  'baraag'
] as const;

export type VaultSiteId = (typeof VAULT_SITE_IDS)[number];

/** Credential shapes stored in the vault (OAuth tokens or site API keys). */
export type SiteCredentialKind = 'refresh-token' | 'access-token' | 'oauth1' | 'api-key';

/** OAuth-only kinds produced by the login window flows. */
export type OAuthCredentialKind = Exclude<SiteCredentialKind, 'api-key'>;

/** How the Settings → Accounts row connects this site. */
export type SiteAuthMode = 'oauth' | 'api-key' | 'unsupported';

/** Settings UI row id (includes aliases that share a vault key). */
export const OAUTH_UI_SITE_IDS = [
  'deviantart',
  'flickr',
  'gelbooru',
  'pixiv',
  'pixiv-novel',
  'reddit',
  'smugmug',
  'tumblr',
  'mastodon.social',
  'pawoo',
  'baraag'
] as const;

export type OAuthUiSiteId = (typeof OAUTH_UI_SITE_IDS)[number];

export interface OAuthUiSite {
  readonly id: OAuthUiSiteId;
  /** Credential vault key; pixiv-novel uses pixiv. */
  readonly vaultId: VaultSiteId;
  /** Hostnames that trigger injecting this site's secrets for a download URL. */
  readonly urlHosts: readonly string[];
  /** gallery-dl extractor category keys written into secret config. */
  readonly galleryDlCategories: readonly string[];
  /** Connect UX: OAuth window, paste API credentials, or blocked (e.g. Flickr). */
  readonly auth: SiteAuthMode;
}

export const OAUTH_UI_SITES: readonly OAuthUiSite[] = [
  {
    id: 'deviantart',
    vaultId: 'deviantart',
    urlHosts: ['deviantart.com'],
    galleryDlCategories: ['deviantart'],
    auth: 'oauth'
  },
  {
    id: 'flickr',
    vaultId: 'flickr',
    urlHosts: ['flickr.com'],
    galleryDlCategories: ['flickr'],
    auth: 'unsupported'
  },
  {
    id: 'gelbooru',
    vaultId: 'gelbooru',
    urlHosts: ['gelbooru.com'],
    galleryDlCategories: ['gelbooru'],
    auth: 'api-key'
  },
  {
    id: 'pixiv',
    vaultId: 'pixiv',
    urlHosts: ['pixiv.net'],
    galleryDlCategories: ['pixiv', 'pixiv-novel'],
    auth: 'oauth'
  },
  {
    id: 'pixiv-novel',
    vaultId: 'pixiv',
    urlHosts: ['pixiv.net'],
    galleryDlCategories: ['pixiv', 'pixiv-novel'],
    auth: 'oauth'
  },
  {
    id: 'reddit',
    vaultId: 'reddit',
    urlHosts: ['reddit.com'],
    galleryDlCategories: ['reddit'],
    auth: 'oauth'
  },
  {
    id: 'smugmug',
    vaultId: 'smugmug',
    urlHosts: ['smugmug.com'],
    galleryDlCategories: ['smugmug'],
    auth: 'oauth'
  },
  {
    id: 'tumblr',
    vaultId: 'tumblr',
    urlHosts: ['tumblr.com'],
    galleryDlCategories: ['tumblr'],
    auth: 'oauth'
  },
  {
    id: 'mastodon.social',
    vaultId: 'mastodon.social',
    urlHosts: ['mastodon.social'],
    galleryDlCategories: ['mastodon'],
    auth: 'oauth'
  },
  {
    id: 'pawoo',
    vaultId: 'pawoo',
    urlHosts: ['pawoo.net'],
    // gallery-dl basecategory is always `mastodon`; instance is selected by URL host.
    galleryDlCategories: ['mastodon'],
    auth: 'oauth'
  },
  {
    id: 'baraag',
    vaultId: 'baraag',
    urlHosts: ['baraag.net'],
    galleryDlCategories: ['mastodon'],
    auth: 'oauth'
  }
];

export function vaultIdForUiSite(uiId: OAuthUiSiteId): VaultSiteId {
  const row = OAUTH_UI_SITES.find((s) => s.id === uiId);
  return row?.vaultId ?? (uiId as VaultSiteId);
}

export function isVaultSiteId(value: string): value is VaultSiteId {
  return (VAULT_SITE_IDS as readonly string[]).includes(value);
}

export function isOAuthUiSiteId(value: string): value is OAuthUiSiteId {
  return (OAUTH_UI_SITE_IDS as readonly string[]).includes(value);
}

/** Vault site ids whose secrets apply to this download URL. */
export function vaultSitesForUrl(rawUrl: string): readonly VaultSiteId[] {
  const host = siteHostOf(rawUrl);
  if (!host) return [];
  const matched = new Set<VaultSiteId>();
  for (const site of OAUTH_UI_SITES) {
    if (site.urlHosts.some((h) => hostMatchesSite(host, h))) matched.add(site.vaultId);
  }
  return [...matched];
}

export function uiSiteById(id: OAuthUiSiteId): OAuthUiSite {
  const site = OAUTH_UI_SITES.find((s) => s.id === id);
  if (!site) throw new Error(`unknown oauth ui site: ${id}`);
  return site;
}
