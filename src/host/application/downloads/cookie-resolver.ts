/**
 * Chooses the cookie file for a run:
 *   1. the cookie explicitly chosen for the download (kept even when missing, so
 *      the failure is reported instead of silently downloading without it);
 *   2. the most specific site binding whose host matches the URL host;
 *   3. the globally active cookie file;
 *   4. none.
 * Automatic candidates (2, 3) that no longer exist in the vault are skipped.
 */
import { hostMatchesSite, siteHostOf } from '../../../shared/domain/url.ts';
import type { HostSettingsRepository } from '../ports/persistence.ts';
import type { CookieVault } from '../ports/secrets.ts';
import type { Logger } from '../ports/system.ts';

export interface CookieResolverDeps {
  readonly settings: HostSettingsRepository;
  readonly vault: CookieVault;
  readonly logger: Logger;
}

export interface CookieTarget {
  readonly sourceUrl: string;
  readonly cookieName: string | null;
}

export class CookieResolver {
  readonly #deps: CookieResolverDeps;

  constructor(deps: CookieResolverDeps) {
    this.#deps = deps;
  }

  async resolve(target: CookieTarget): Promise<string | null> {
    if (target.cookieName) return target.cookieName;
    const { cookies } = this.#deps.settings.load();
    const host = siteHostOf(target.sourceUrl);
    if (host) {
      const bindings = cookies.bindings
        .filter((binding) => hostMatchesSite(host, binding.siteHost))
        .sort((a, b) => b.siteHost.length - a.siteHost.length);
      for (const binding of bindings) {
        if (await this.#exists(binding.cookieName)) return binding.cookieName;
      }
    }
    if (cookies.active && (await this.#exists(cookies.active))) return cookies.active;
    return null;
  }

  async #exists(name: string): Promise<boolean> {
    try {
      return await this.#deps.vault.exists(name);
    } catch (error) {
      this.#deps.logger.warn('cookie lookup failed', { error: String(error) });
      return false;
    }
  }
}
