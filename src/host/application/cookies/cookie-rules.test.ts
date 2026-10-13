import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { sequentialIds } from '../testing-a2/recording-event-sink.ts';
import {
  mergeImportedBindings,
  normalizeBindings,
  normalizeSiteHost,
  utf8ByteLength,
  validateCookieFileName
} from './cookie-rules.ts';

describe('cookie rules', () => {
  it('validates portable cookie file names', () => {
    assert.ok(validateCookieFileName('danbooru.txt').ok);
    assert.ok(validateCookieFileName('my cookies (2).txt').ok);
    for (const name of [
      '.hidden.txt',
      'con.txt',
      'NUL.txt',
      ' a.txt',
      'a .txt',
      '.txt',
      'a.cookies',
      'a/b.txt',
      'a..txt'
    ]) {
      const result = validateCookieFileName(name);
      assert.ok(!result.ok && result.error.code === ErrorCode.COOKIES_INVALID_NAME, name);
    }
  });

  it('measures UTF-8 bytes, not UTF-16 units', () => {
    assert.equal(utf8ByteLength('abc'), 3);
    assert.equal(utf8ByteLength('ç'), 2);
    assert.equal(utf8ByteLength('€'), 3);
    assert.equal(utf8ByteLength('😀'), 4);
    assert.equal(utf8ByteLength('\uD800x'), 4);
  });

  it('normalizes site hosts', () => {
    assert.equal(normalizeSiteHost(' Danbooru.Donmai.US '), 'danbooru.donmai.us');
    assert.equal(normalizeSiteHost('.pixiv.net'), 'pixiv.net');
    assert.equal(normalizeSiteHost('www.x.com'), 'x.com');
    assert.equal(normalizeSiteHost('https://www.Rule34.xxx/index.php?page=post'), 'rule34.xxx');
    assert.equal(normalizeSiteHost('..'), null);
    assert.equal(normalizeSiteHost('bad host'), null);
    assert.equal(normalizeSiteHost('ftp://x.com'), null);
  });

  it('normalizes a binding list, rejecting unknown files and keeping the first duplicate', () => {
    const known = new Set(['a.txt', 'b.txt']);
    const result = normalizeBindings(
      [
        { id: '1', siteHost: 'WWW.Site.com', cookieName: 'a.txt' },
        { id: '2', siteHost: 'site.com', cookieName: 'b.txt' },
        { id: '1', siteHost: 'other.com', cookieName: 'b.txt' },
        { id: '3', siteHost: 'other.com', cookieName: 'b.txt' }
      ],
      known
    );
    assert.deepEqual(result, {
      ok: true,
      value: [
        { id: '1', siteHost: 'site.com', cookieName: 'a.txt' },
        { id: '3', siteHost: 'other.com', cookieName: 'b.txt' }
      ]
    });
    const unknown = normalizeBindings([{ id: '1', siteHost: 'x.com', cookieName: 'zzz.txt' }], known);
    assert.ok(
      !unknown.ok && unknown.error.code === ErrorCode.COOKIES_NOT_FOUND && unknown.error.params?.['name'] === 'zzz.txt'
    );
    const badHost = normalizeBindings([{ id: '1', siteHost: '...', cookieName: 'a.txt' }], known);
    assert.ok(!badHost.ok && badHost.error.params?.['path'] === 'bindings.0.siteHost');
  });

  it('merges imported bindings without duplicates and respects the cap', () => {
    const current = [{ id: 'x', siteHost: 'site.com', cookieName: 'a.txt' }];
    const incoming = [
      { id: 'y', siteHost: 'site.com', cookieName: 'b.txt' },
      { id: 'x', siteHost: 'new.com', cookieName: 'b.txt' },
      { id: 'z', siteHost: 'gone.com', cookieName: 'missing.txt' },
      { id: 'w', siteHost: 'extra.com', cookieName: 'a.txt' }
    ];
    const merged = mergeImportedBindings(current, incoming, new Set(['a.txt', 'b.txt']), 2, sequentialIds('new'));
    assert.equal(merged.added, 1);
    assert.deepEqual(merged.bindings, [
      { id: 'x', siteHost: 'site.com', cookieName: 'a.txt' },
      { id: 'new1', siteHost: 'new.com', cookieName: 'b.txt' }
    ]);
  });
});
