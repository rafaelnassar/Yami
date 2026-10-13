import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { createWorld } from '../testing-a2/world.ts';
import { AccountsStatus, DISCONNECTED_ACCOUNTS, emptySitesRecord, toAccountsDtoFromMap } from './accounts-status.ts';
import { PixivAccountService } from './pixiv-account-service.ts';
import { SiteAccountService } from './site-account-service.ts';

function connectedPixivAccounts(userName: string | null) {
  const sites = {
    ...emptySitesRecord(),
    pixiv: { connected: true, userName }
  };
  return { sites, pixiv: sites.pixiv };
}

function setup() {
  const world = createWorld();
  const status = new AccountsStatus(world.credentials);
  const service = new PixivAccountService(world.credentials, status, world.state, world.clock);
  return { world, status, service };
}

describe('PixivAccountService', () => {
  it('saves credentials and returns only the public status', async () => {
    const { world, status, service } = setup();
    const result = await service.save({ refreshToken: '  refresh-token-123  ', userName: ' ana ', userId: '42' });
    assert.deepEqual(result, { ok: true, value: { accounts: connectedPixivAccounts('ana') } });
    assert.ok(!JSON.stringify(result).includes('refresh-token-123'));
    assert.deepEqual(world.credentials.pixiv, {
      refreshToken: 'refresh-token-123',
      userName: 'ana',
      userId: '42',
      savedAt: world.clock.now()
    });
    assert.deepEqual(status.current(), connectedPixivAccounts('ana'));
    assert.equal(world.state.calls, 1);
  });

  it('rejects a malformed token without touching the vault', async () => {
    const { world, service } = setup();
    const result = await service.save({ refreshToken: 'abc def ghi jkl', userName: null, userId: null });
    assert.ok(!result.ok);
    assert.equal(result.error.code, ErrorCode.VALIDATION_FAILED);
    assert.equal(world.credentials.pixiv, null);
    assert.equal(world.state.calls, 0);
  });

  it('clears credentials', async () => {
    const { world, service } = setup();
    await service.save({ refreshToken: 'refresh-token-123', userName: '', userId: null });
    const result = await service.clear();
    assert.deepEqual(result, { ok: true, value: { accounts: DISCONNECTED_ACCOUNTS } });
    assert.equal(world.credentials.pixiv, null);
    assert.equal(world.state.calls, 2);
  });
});

describe('AccountsStatus', () => {
  it('loads from the vault once and can be refreshed', async () => {
    const world = createWorld();
    const status = new AccountsStatus(world.credentials);
    assert.deepEqual(status.current(), DISCONNECTED_ACCOUNTS);
    world.credentials.pixiv = { refreshToken: 'tok', userName: null, userId: null, savedAt: 1 };
    await status.ensureLoaded();
    await status.ensureLoaded();
    assert.equal(world.credentials.reads, 1);
    assert.equal(status.current().pixiv.connected, true);
    world.credentials.pixiv = null;
    world.credentials.sites.delete('pixiv');
    await status.refresh();
    assert.equal(status.current().pixiv.connected, false);
  });

  it('maps multiple sites from the vault', () => {
    const map = new Map([
      [
        'reddit',
        {
          kind: 'refresh-token' as const,
          refreshToken: 'x'.repeat(12),
          userName: 'u',
          userId: null,
          savedAt: 1
        }
      ]
    ]);
    const dto = toAccountsDtoFromMap(map);
    assert.equal(dto.sites.reddit?.connected, true);
    assert.equal(dto.sites.pixiv?.connected, false);
  });

  it('marks api-key sites connected when apiKey and userId are present', () => {
    const dto = toAccountsDtoFromMap(
      new Map([
        [
          'gelbooru',
          {
            kind: 'api-key' as const,
            apiKey: 'a'.repeat(16),
            userName: null,
            userId: '2065192',
            savedAt: 1
          }
        ]
      ])
    );
    assert.equal(dto.sites.gelbooru?.connected, true);
    assert.equal(dto.sites.gelbooru?.userName, null);
  });
});

describe('SiteAccountService api-key', () => {
  it('saves gelbooru api-key credentials', async () => {
    const world = createWorld();
    const status = new AccountsStatus(world.credentials);
    const service = new SiteAccountService(world.credentials, status, world.state, world.clock);
    const result = await service.save({
      siteId: 'gelbooru',
      kind: 'api-key',
      apiKey: 'abcdef0123456789',
      userName: null,
      userId: '2065192'
    });
    assert.ok(result.ok);
    assert.equal(result.value.accounts.sites.gelbooru?.connected, true);
    assert.ok(!JSON.stringify(result).includes('abcdef0123456789'));
    assert.deepEqual(world.credentials.sites.get('gelbooru'), {
      kind: 'api-key',
      apiKey: 'abcdef0123456789',
      userName: null,
      userId: '2065192',
      savedAt: world.clock.now()
    });
  });

  it('rejects api-key without userId', async () => {
    const world = createWorld();
    const status = new AccountsStatus(world.credentials);
    const service = new SiteAccountService(world.credentials, status, world.state, world.clock);
    const result = await service.save({
      siteId: 'gelbooru',
      kind: 'api-key',
      apiKey: 'abcdef0123456789',
      userName: null,
      userId: null
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, ErrorCode.VALIDATION_FAILED);
  });
});
