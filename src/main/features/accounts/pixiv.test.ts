import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { err, ok } from '../../../shared/kernel/result.ts';
import { nullLogger } from '../../infrastructure/logger.ts';
import { OAuthAccounts } from './oauth-accounts.ts';
import {
  base64Url,
  challengeFor,
  createPkcePair,
  extractPixivAuthCode,
  isAllowedLoginNavigation,
  parseTokenResponse,
  pixivLoginUrl,
  tokenRequestBody
} from './pixiv-protocol.ts';

describe('Pixiv PKCE', () => {
  it('derives an S256 challenge from a base64url verifier', () => {
    const pair = createPkcePair(() => new Uint8Array(32).fill(7));
    assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
    const expected = createHash('sha256')
      .update(pair.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(pair.challenge, expected);
    assert.equal(challengeFor(pair.verifier), pair.challenge);
    assert.equal(base64Url(new Uint8Array([251, 255])), '-_8');
  });

  it('builds the login URL and the token request', () => {
    const url = new URL(pixivLoginUrl('abc'));
    assert.equal(url.origin + url.pathname, 'https://app-api.pixiv.net/web/v1/login');
    assert.equal(url.searchParams.get('code_challenge'), 'abc');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('client'), 'pixiv-android');
    const body = tokenRequestBody('the-code', 'the-verifier');
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code_verifier'), 'the-verifier');
    assert.equal(body.get('redirect_uri'), 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback');
  });
});

describe('Pixiv redirect capture', () => {
  it('reads the code from the callback page and the pixiv:// deep link', () => {
    assert.equal(
      extractPixivAuthCode('https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?state=x&code=AbC'),
      'AbC'
    );
    assert.equal(extractPixivAuthCode('pixiv://account/login?code=XyZ&via=login'), 'XyZ');
  });

  it('ignores lookalike hosts, wrong paths and empty codes', () => {
    assert.equal(extractPixivAuthCode('https://evilpixiv.net/web/v1/users/auth/pixiv/callback?code=a'), null);
    assert.equal(extractPixivAuthCode('https://pixiv.net.evil.com/web/v1/users/auth/pixiv/callback?code=a'), null);
    assert.equal(extractPixivAuthCode('http://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?code=a'), null);
    assert.equal(extractPixivAuthCode('https://accounts.pixiv.net/login?code=a'), null);
    assert.equal(extractPixivAuthCode('pixiv://account/login?code='), null);
    assert.equal(extractPixivAuthCode('pixiv://other/login?code=a'), null);
    assert.equal(extractPixivAuthCode('garbage'), null);
  });

  it('restricts top-level navigation to the login hosts over https', () => {
    assert.equal(isAllowedLoginNavigation('https://accounts.pixiv.net/login'), true);
    assert.equal(isAllowedLoginNavigation('https://accounts.google.com/o/oauth2'), true);
    assert.equal(isAllowedLoginNavigation('http://accounts.pixiv.net/login'), false);
    assert.equal(isAllowedLoginNavigation('https://example.com/'), false);
    assert.equal(isAllowedLoginNavigation('file:///etc/passwd'), false);
  });
});

describe('Pixiv token response', () => {
  it('accepts top-level or nested token/user fields', () => {
    assert.deepEqual(
      parseTokenResponse(200, JSON.stringify({ refresh_token: ' rt-123 ', user: { name: 'Ann', id: 5 } })),
      ok({ refreshToken: 'rt-123', userName: 'Ann', userId: '5' })
    );
    assert.deepEqual(
      parseTokenResponse(200, JSON.stringify({ response: { refresh_token: 'rt', user: { account: 'acc', id: '9' } } })),
      ok({ refreshToken: 'rt', userName: 'acc', userId: '9' })
    );
  });

  it('maps errors, non-JSON bodies and missing tokens to PIXIV_LOGIN_FAILED', () => {
    const cases: Array<[number, string, string]> = [
      [400, JSON.stringify({ error: 'invalid_grant' }), 'invalid_grant'],
      [502, '<html>Bad gateway</html>', 'HTTP 502'],
      [200, 'not json', 'invalid response'],
      [200, JSON.stringify({ user: {} }), 'no refresh token']
    ];
    for (const [status, body, detail] of cases) {
      assert.deepEqual(parseTokenResponse(status, body), err({ code: 'PIXIV_LOGIN_FAILED', params: { detail } }));
    }
  });
});

describe('OAuthAccounts (Pixiv)', () => {
  const accountsDto = {
    pixiv: { connected: true, userName: 'Ann' },
    sites: { pixiv: { connected: true, userName: 'Ann' } }
  };

  const baseDeps = () => ({
    loginSite: async () =>
      ok({ kind: 'refresh-token' as const, refreshToken: 'x'.repeat(12), userName: null, userId: null }),
    saveSite: async () => ok({ accounts: accountsDto }),
    clearSite: async () => ok({ accounts: accountsDto }),
    clearSiteWebSession: async () => undefined,
    logger: nullLogger
  });

  it('is single-flight and sends the token only to the host', async () => {
    let release: () => void = () => undefined;
    const saved: unknown[] = [];
    const account = new OAuthAccounts({
      ...baseDeps(),
      loginPixiv: () =>
        new Promise((resolve) => {
          release = () => resolve(ok({ refreshToken: 'secret-token', userName: 'Ann', userId: '1' }));
        }),
      savePixiv: async (payload) => {
        saved.push(payload);
        return ok({ accounts: accountsDto });
      },
      clearPixiv: async () => ok({ accounts: accountsDto }),
      clearPixivWebSession: async () => undefined,
      hostReady: () => true,
      vaultReady: () => true
    });
    const first = account.connectPixiv();
    const second = await account.connectPixiv();
    assert.equal(!second.ok && second.error.code, 'OAUTH_LOGIN_IN_PROGRESS');
    release();
    const result = await first;
    assert.deepEqual(result, ok(accountsDto));
    assert.ok(!JSON.stringify(result).includes('secret-token'));
    assert.deepEqual(saved, [{ refreshToken: 'secret-token', userName: 'Ann', userId: '1' }]);
  });

  it('fails fast when the host is not ready and clears the web session on disconnect', async () => {
    let cleared = false;
    const account = new OAuthAccounts({
      ...baseDeps(),
      loginPixiv: async () => ok({ refreshToken: 'x'.repeat(20), userName: null, userId: null }),
      savePixiv: async () => ok({ accounts: accountsDto }),
      clearPixiv: async () =>
        ok({
          accounts: {
            pixiv: { connected: false, userName: null },
            sites: { pixiv: { connected: false, userName: null } }
          }
        }),
      clearPixivWebSession: async () => {
        cleared = true;
      },
      hostReady: () => false,
      vaultReady: () => true
    });
    const connect = await account.connectPixiv();
    assert.equal(!connect.ok && connect.error.code, 'HOST_UNAVAILABLE');
    const disconnect = await account.disconnectPixiv();
    assert.equal(disconnect.ok && disconnect.value.pixiv.connected, false);
    assert.equal(cleared, true);
  });

  it('refuses to log in while the vault is disabled (the token could not be stored)', async () => {
    let logins = 0;
    const account = new OAuthAccounts({
      ...baseDeps(),
      loginPixiv: async () => {
        logins += 1;
        return ok({ refreshToken: 'x'.repeat(20), userName: null, userId: null });
      },
      savePixiv: async () => ok({ accounts: accountsDto }),
      clearPixiv: async () => ok({ accounts: accountsDto }),
      clearPixivWebSession: async () => undefined,
      hostReady: () => true,
      vaultReady: () => false
    });
    const connect = await account.connectPixiv();
    assert.equal(!connect.ok && connect.error.code, 'VAULT_UNAVAILABLE');
    assert.equal(logins, 0);
  });

  it('rejects Flickr connect with NOT_SUPPORTED', async () => {
    const account = new OAuthAccounts({
      ...baseDeps(),
      loginPixiv: async () => ok({ refreshToken: 'x'.repeat(20), userName: null, userId: null }),
      savePixiv: async () => ok({ accounts: accountsDto }),
      clearPixiv: async () => ok({ accounts: accountsDto }),
      clearPixivWebSession: async () => undefined,
      hostReady: () => true,
      vaultReady: () => true
    });
    const result = await account.connect('flickr');
    assert.equal(!result.ok && result.error.code, 'NOT_SUPPORTED');
  });
});
