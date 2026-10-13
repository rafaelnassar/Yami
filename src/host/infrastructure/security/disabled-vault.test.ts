import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountsStatus, emptySitesRecord } from '../../application/accounts/accounts-status.ts';
import { PixivAccountService } from '../../application/accounts/pixiv-account-service.ts';
import { CookieFilesService } from '../../application/cookies/cookie-files-service.ts';
import { CookiePreferencesService } from '../../application/cookies/cookie-preferences-service.ts';
import { CookiesSnapshotBuilder } from '../../application/cookies/cookies-snapshot.ts';
import { FixedClock } from '../../application/testing-a2/recording-event-sink.ts';
import { createWorld } from '../../application/testing-a2/world.ts';
import type { CookieVault } from '../../application/ports/secrets.ts';
import { DisabledCookieVault, DisabledCredentialVault } from './disabled-vault.ts';

const UNAVAILABLE = { ok: false, error: { code: 'VAULT_UNAVAILABLE' } };

describe('DisabledCookieVault', () => {
  it('lists nothing, finds nothing and refuses every read or write', async () => {
    const vault: CookieVault = new DisabledCookieVault();
    assert.deepEqual(await vault.list(), []);
    assert.equal(await vault.exists('site.txt'), false);
    assert.deepEqual(await vault.domainsOf('site.txt'), []);
    assert.deepEqual(await vault.save('site.txt', '# Netscape HTTP Cookie File\n'), UNAVAILABLE);
    assert.deepEqual(await vault.remove('site.txt'), UNAVAILABLE);
    assert.deepEqual(await vault.materialize('site.txt', '/work/job'), UNAVAILABLE);
    await vault.absorb('site.txt', '/work/job/site.txt');
  });

  it('makes cookie uploads, deletions, selection and rules fail without dropping the saved references', async () => {
    const world = createWorld();
    const current = world.settingsRepository.current;
    world.settingsRepository.current = {
      ...current,
      cookies: {
        active: 'site.txt',
        fromBrowser: false,
        bindings: [{ id: 'b1', siteHost: 'site.com', cookieName: 'site.txt' }]
      }
    };
    const vault = new DisabledCookieVault();
    const snapshots = new CookiesSnapshotBuilder(vault, world.settings, world.sink);
    const deps = { vault, settings: world.settings, snapshots, state: world.state, vaultReady: () => false };
    const files = new CookieFilesService(deps);
    const preferences = new CookiePreferencesService(deps);

    assert.deepEqual(await files.list(), {
      ok: true,
      value: { files: [], active: null, bindings: [], fromBrowser: false }
    });
    assert.deepEqual(await files.upload({ name: 'new.txt', content: '# Netscape HTTP Cookie File\n' }), UNAVAILABLE);
    assert.deepEqual(await files.delete({ name: 'site.txt' }), UNAVAILABLE);
    // The snapshot hides the saved choices: replacing them would wipe what comes back later.
    assert.deepEqual(await preferences.setBindings({ bindings: [] }), UNAVAILABLE);
    assert.deepEqual(await preferences.select({ name: null }), UNAVAILABLE);
    assert.deepEqual(await preferences.select({ name: 'site.txt' }), UNAVAILABLE);
    assert.equal(world.settingsRepository.current.cookies.active, 'site.txt');
    assert.equal(world.settingsRepository.current.cookies.bindings.length, 1);
    assert.equal(world.state.calls, 0);
    // Browser cookies do not depend on the vault.
    const browser = await preferences.setFromBrowser({ enabled: true });
    assert.equal(browser.ok && browser.value.fromBrowser, true);
  });
});

describe('DisabledCredentialVault', () => {
  it('has no Pixiv login and refuses to store or clear one', async () => {
    const vault = new DisabledCredentialVault();
    assert.equal(await vault.getPixiv(), null);
    const accounts = new AccountsStatus(vault);
    assert.deepEqual(await accounts.refresh(), {
      sites: emptySitesRecord(),
      pixiv: { connected: false, userName: null }
    });
    const world = createWorld();
    const service = new PixivAccountService(vault, accounts, world.state, new FixedClock(1));
    await assert.rejects(service.save({ refreshToken: 'x'.repeat(20), userName: 'ana', userId: '1' }), {
      code: 'VAULT_UNAVAILABLE'
    });
    await assert.rejects(service.clear(), { code: 'VAULT_UNAVAILABLE' });
    assert.equal(accounts.current().pixiv.connected, false);
  });
});
