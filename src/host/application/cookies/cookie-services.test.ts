import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import type { HostSettings } from '../ports/persistence.ts';
import { createWorld, type World } from '../testing-a2/world.ts';
import { CookieFilesService } from './cookie-files-service.ts';
import { CookiePreferencesService } from './cookie-preferences-service.ts';
import { CookiesSnapshotBuilder } from './cookies-snapshot.ts';

function setup(cookies: readonly string[] = ['a.txt', 'b.txt']) {
  const world = createWorld({ cookies });
  const snapshots = new CookiesSnapshotBuilder(world.cookieVault, world.settings, world.sink);
  const deps = { vault: world.cookieVault, settings: world.settings, snapshots, state: world.state };
  return { world, snapshots, files: new CookieFilesService(deps), preferences: new CookiePreferencesService(deps) };
}

function setCookies(world: World, cookies: Partial<HostSettings['cookies']>): void {
  const current = world.settingsRepository.current;
  world.settingsRepository.current = { ...current, cookies: { ...current.cookies, ...cookies } };
}

describe('CookiesSnapshotBuilder', () => {
  it('hides references to cookie files that no longer exist', async () => {
    const { world, snapshots } = setup(['b.txt', 'a.txt']);
    setCookies(world, {
      active: 'gone.txt',
      bindings: [
        { id: '1', siteHost: 'x.com', cookieName: 'gone.txt' },
        { id: '2', siteHost: 'y.com', cookieName: 'a.txt' }
      ]
    });
    const snapshot = await snapshots.build();
    assert.deepEqual(
      snapshot.files.map((file) => file.name),
      ['a.txt', 'b.txt']
    );
    assert.equal(snapshot.active, null);
    assert.deepEqual(
      snapshot.bindings.map((binding) => binding.id),
      ['2']
    );
  });
});

describe('CookieFilesService', () => {
  it('uploads a valid file and publishes cookies.changed', async () => {
    const { world, files } = setup([]);
    const result = await files.upload({ name: 'site.txt', content: '# Netscape HTTP Cookie File\n' });
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.files.map((file) => file.name),
      ['site.txt']
    );
    assert.equal(result.value.active, null);
    assert.deepEqual(world.sink.ofType('cookies.changed')[0]?.cookies, result.value);
  });

  it('rejects bad names, oversized content (in bytes) and vault errors', async () => {
    const { world, files } = setup([]);
    const name = await files.upload({ name: 'con.txt', content: 'x' });
    assert.ok(!name.ok && name.error.code === ErrorCode.COOKIES_INVALID_NAME);
    const big = await files.upload({ name: 'big.txt', content: 'é'.repeat(LIMITS.maxCookieFileBytes / 2 + 1) });
    assert.ok(!big.ok && big.error.code === ErrorCode.COOKIES_TOO_LARGE);
    world.cookieVault.saveError = appError(ErrorCode.COOKIES_INVALID_FORMAT);
    const format = await files.upload({ name: 'x.txt', content: 'garbage' });
    assert.ok(!format.ok && format.error.code === ErrorCode.COOKIES_INVALID_FORMAT);
    assert.equal(world.sink.events.length, 0);
  });

  it('deleting a file clears the active selection and its bindings', async () => {
    const { world, files } = setup();
    setCookies(world, {
      active: 'a.txt',
      bindings: [
        { id: '1', siteHost: 'x.com', cookieName: 'a.txt' },
        { id: '2', siteHost: 'y.com', cookieName: 'b.txt' }
      ]
    });
    const result = await files.delete({ name: 'a.txt' });
    assert.ok(result.ok);
    assert.equal(world.cookieVault.files.has('a.txt'), false);
    assert.equal(world.settingsRepository.current.cookies.active, null);
    assert.deepEqual(
      world.settingsRepository.current.cookies.bindings.map((binding) => binding.id),
      ['2']
    );
    assert.equal(world.state.calls, 1);
    assert.equal(world.sink.ofType('cookies.changed').length, 1);
  });

  it('deleting a missing file is idempotent but other vault errors are returned', async () => {
    const { world, files } = setup();
    setCookies(world, { bindings: [{ id: '1', siteHost: 'x.com', cookieName: 'ghost.txt' }] });
    const missing = await files.delete({ name: 'ghost.txt' });
    assert.ok(missing.ok);
    assert.deepEqual(world.settingsRepository.current.cookies.bindings, []);
    assert.equal(world.state.calls, 0);
    world.cookieVault.removeError = appError(ErrorCode.VAULT_UNAVAILABLE);
    const failed = await files.delete({ name: 'a.txt' });
    assert.ok(!failed.ok && failed.error.code === ErrorCode.VAULT_UNAVAILABLE);
  });
});

describe('CookiePreferencesService', () => {
  it('selects an existing file or clears the selection', async () => {
    const { world, preferences } = setup();
    const selected = await preferences.select({ name: 'b.txt' });
    assert.ok(selected.ok && selected.value.active === 'b.txt');
    assert.equal(world.settingsRepository.current.cookies.active, 'b.txt');
    const cleared = await preferences.select({ name: null });
    assert.ok(cleared.ok && cleared.value.active === null);
    assert.equal(world.state.calls, 2);
  });

  it('refuses to select a file that does not exist', async () => {
    const { world, preferences } = setup();
    const result = await preferences.select({ name: 'zzz.txt' });
    assert.ok(!result.ok && result.error.code === ErrorCode.COOKIES_NOT_FOUND);
    assert.equal(world.settingsRepository.saves, 0);
  });

  it('stores normalized bindings, all-or-nothing', async () => {
    const { world, preferences } = setup();
    const result = await preferences.setBindings({
      bindings: [
        { id: 'k1', siteHost: 'www.Danbooru.donmai.us', cookieName: 'a.txt' },
        { id: 'k2', siteHost: 'danbooru.donmai.us', cookieName: 'b.txt' }
      ]
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.bindings, [{ id: 'k1', siteHost: 'danbooru.donmai.us', cookieName: 'a.txt' }]);
    assert.deepEqual(world.settingsRepository.current.cookies.bindings, result.value.bindings);

    const rejected = await preferences.setBindings({
      bindings: [
        { id: 'k3', siteHost: 'x.com', cookieName: 'a.txt' },
        { id: 'k4', siteHost: 'y.com', cookieName: 'deleted.txt' }
      ]
    });
    assert.ok(!rejected.ok && rejected.error.code === ErrorCode.COOKIES_NOT_FOUND);
    assert.deepEqual(world.settingsRepository.current.cookies.bindings, result.value.bindings);
    assert.equal(world.sink.ofType('cookies.changed').length, 1);
  });

  it('toggles browser cookies and republishes state only on change', async () => {
    const { world, preferences } = setup();
    const result = await preferences.setFromBrowser({ enabled: true });
    assert.ok(result.ok && result.value.fromBrowser);
    await preferences.setFromBrowser({ enabled: true });
    assert.equal(world.state.calls, 1);
    assert.equal(world.settingsRepository.saves, 1);
    assert.equal(world.sink.ofType('cookies.changed').length, 2);
  });
});
