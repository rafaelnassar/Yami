import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextCookieRetry, type CookieRetryInput } from './cookie-retry-policy.ts';
import { INITIAL_RETRY } from './download-state.ts';

function input(partial: Partial<CookieRetryInput>): CookieRetryInput {
  return {
    engine: 'yt-dlp',
    outcomeKind: 'error',
    errorKind: null,
    usedBrowserCookies: false,
    browserCookiesOptIn: true,
    retry: INITIAL_RETRY,
    ...partial
  };
}

describe('nextCookieRetry', () => {
  it('retries without browser cookies when the cookie database could not be copied', () => {
    assert.equal(nextCookieRetry(input({ errorKind: 'cookie-copy', usedBrowserCookies: true })), 'skip');
    assert.equal(
      nextCookieRetry(
        input({ errorKind: 'cookie-copy', usedBrowserCookies: true, retry: { ...INITIAL_RETRY, skipTried: true } })
      ),
      null
    );
    assert.equal(nextCookieRetry(input({ errorKind: 'cookie-copy', usedBrowserCookies: false })), null);
  });

  it('retries with browser cookies after a login/bot check', () => {
    assert.equal(nextCookieRetry(input({ errorKind: 'cookies-auth' })), 'force');
    assert.equal(
      nextCookieRetry(input({ errorKind: 'cookies-auth', retry: { ...INITIAL_RETRY, forceTried: true } })),
      null
    );
    assert.equal(nextCookieRetry(input({ errorKind: 'cookies-auth', usedBrowserCookies: true })), null);
  });

  it('never forces browser cookies without the user opt-in (a server-chosen error text cannot trigger it)', () => {
    assert.equal(nextCookieRetry(input({ errorKind: 'cookies-auth', browserCookiesOptIn: false })), null);
    assert.equal(
      nextCookieRetry(input({ errorKind: 'cookies-auth', outcomeKind: 'empty', browserCookiesOptIn: false })),
      null
    );
    // Dropping browser cookies is always allowed.
    assert.equal(
      nextCookieRetry(input({ errorKind: 'cookie-copy', usedBrowserCookies: true, browserCookiesOptIn: false })),
      'skip'
    );
  });

  it('only for yt-dlp and only for failed outcomes', () => {
    assert.equal(nextCookieRetry(input({ engine: 'gallery-dl', errorKind: 'cookies-auth' })), null);
    assert.equal(nextCookieRetry(input({ errorKind: 'cookies-auth', outcomeKind: 'partial' })), null);
    assert.equal(nextCookieRetry(input({ errorKind: 'cookies-auth', outcomeKind: 'ok' })), null);
    assert.equal(nextCookieRetry(input({ errorKind: 'cookies-auth', outcomeKind: 'empty' })), 'force');
    assert.equal(nextCookieRetry(input({ errorKind: 'network' })), null);
  });
});
