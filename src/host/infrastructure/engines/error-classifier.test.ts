import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineErrorKind } from '../../domain/engines/parsed-line.ts';
import { classifyEngineError, sourceTagOf } from './error-classifier.ts';

const TABLE: ReadonlyArray<readonly [string, EngineErrorKind, string | null]> = [
  // Legacy kinds (same English triggers as the legacy regexes).
  [
    'Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info',
    'cookie-copy',
    null
  ],
  ['Failed to decrypt with DPAPI: cookie database locked', 'cookie-copy', null],
  [
    '[youtube] FiOBHYPKyjs: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
    'cookies-auth',
    null
  ],
  ['[youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'cookies-auth', null],
  ["AuthenticationError: 'refresh-token' required.", 'pixiv-auth', null],
  ["AuthenticationError: 'refresh-token' required.", 'pixiv-auth', 'pixiv'],
  ['Invalid refresh token', 'pixiv-auth', null],
  // Q11: only YouTube's cookie hint is cookies-auth; other sites need a login.
  [
    '[instagram] C1: Requested content is not available, rate-limit reached or login required. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (instagram) to provide account credentials',
    'login-required',
    null
  ],
  [
    '[youtube] abc: This content requires login. Use --cookies-from-browser or --cookies for the authentication.',
    'cookies-auth',
    null
  ],
  ['AuthenticationError: Invalid username or password', 'login-required', 'twitter'],
  ['401 Unauthorized', 'login-required', 'twitter'],
  ['[vimeo] 123: This video is only available for registered users', 'login-required', null],
  // New kinds.
  ['unable to download video data: HTTP Error 429: Too Many Requests', 'rate-limited', null],
  ["'429 Too Many Requests' for 'https://x/y'", 'rate-limited', 'kemonoparty'],
  ['[generic] Unsupported URL: https://example.com/page', 'unsupported-url', null],
  ["No suitable extractor found for 'https://example.com/'", 'unsupported-url', null],
  ['HttpError: 404', 'not-found', null],
  ['[twitter] 123: Requested tweet does not exist', 'not-found', null],
  ['User not found', 'not-found', 'deviantart'],
  [
    "[youtube] abc: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser",
    'private',
    null
  ],
  ['[youtube] abc: This video is private', 'private', null],
  [
    '[youtube] abc: Join this channel to get access to members-only content like this video, and other exclusive perks.',
    'private',
    null
  ],
  ['[youtube] abc: The uploader has not made this video available in your country', 'geo-blocked', null],
  ['[bbc] x: This video is not available in your country due to geo restriction', 'geo-blocked', null],
  ['Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>', 'network', null],
  ['Unable to download webpage: The read operation timed out', 'network', null],
  ['[Errno 104] Connection reset by peer', 'network', null],
  ['Connection refused', 'network', null],
  [
    '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1006)',
    'network',
    null
  ],
  // Missing tools are not missing content.
  ['ffmpeg not found. Please install or provide the path using --ffmpeg-location', 'unknown', null],
  ['[youtube] x: Video unavailable', 'unknown', null],
  ['unable to download video data: HTTP Error 403: Forbidden', 'unknown', null]
];

describe('classifyEngineError', () => {
  for (const [message, expected, source] of TABLE) {
    it(`${expected} ← ${message.slice(0, 70)}`, () => {
      assert.equal(classifyEngineError(message, { source }), expected);
    });
  }

  it('does not keep the legacy Portuguese re-classification fragments (Q12)', () => {
    assert.equal(classifyEngineError('O YouTube pediu login.'), 'unknown');
    assert.equal(classifyEngineError('Não foi possível copiar os cookies do Chrome.'), 'unknown');
  });

  // Security: `cookies-auth` can start a browser-cookie retry, so the YouTube wording
  // alone (which any site can echo in a page or an HTTP reason phrase) must not grant it.
  it('grants cookies-auth for the bot check only with a YouTube extractor tag', () => {
    assert.equal(classifyEngineError('[youtube:tab] PL1: Sign in to confirm you’re not a bot.'), 'cookies-auth');
    assert.equal(classifyEngineError('[generic] x: Unable to download webpage: HTTP Error 403: not a bot'), 'unknown');
    assert.equal(
      classifyEngineError('[generic] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies'),
      'login-required'
    );
    assert.equal(
      classifyEngineError('unable to download video data: HTTP Error 403: Sign in to confirm you’re not a bot'),
      'unknown'
    );
    assert.equal(classifyEngineError('HTTP Error 403: not a bot', { source: 'kemonoparty' }), 'unknown');
    // The explicit source wins over a tag the site could have placed in the text.
    assert.equal(
      classifyEngineError('[youtube] x: Sign in to confirm you’re not a bot', { source: 'generic' }),
      'unknown'
    );
    assert.equal(classifyEngineError('[youtubefake] x: Sign in to confirm you’re not a bot'), 'unknown');
    assert.equal(classifyEngineError('[web.archive:youtube] x: not a bot'), 'unknown');
  });

  it('reads the extractor tag of yt-dlp messages', () => {
    assert.equal(sourceTagOf('[youtube:tab] PL1: x'), 'youtube:tab');
    assert.equal(sourceTagOf('unable to download'), null);
  });
});

// Ports the classification half of the legacy cookie-retry tests (the retry decision
// itself is the downloads core's CookieRetryPolicy).
describe('YouTube browser cookies (legacy retry triggers)', () => {
  it('retries without cookies when Chrome locks the cookie database', () => {
    assert.equal(
      classifyEngineError(
        'Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info'
      ),
      'cookie-copy'
    );
  });

  it('retries with browser cookies after a YouTube bot check', () => {
    assert.equal(
      classifyEngineError(
        '[youtube] FiOBHYPKyjs: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.'
      ),
      'cookies-auth'
    );
  });
});
