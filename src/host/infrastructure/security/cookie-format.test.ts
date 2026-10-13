import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import { parseNetscapeCookies } from './cookie-format.ts';
import { isValidCookieName, toCookieName, validateCookieName } from './cookie-name.ts';
import { VALID_COOKIES } from './test-fixtures.ts';

function errorOf(content: string): { code: string; line: unknown } | null {
  const result = parseNetscapeCookies(content);
  return result.ok ? null : { code: result.error.code, line: result.error.params?.['line'] };
}

describe('parseNetscapeCookies', () => {
  it('accepts a valid file with header, comments, HttpOnly lines and CRLF', () => {
    const result = parseNetscapeCookies(`\uFEFF${VALID_COOKIES}\n`);
    assert.ok(result.ok);
    assert.equal(result.value.cookieCount, 4);
    assert.deepEqual(result.value.domains, ['x.com', 'example.com', 'danbooru.donmai.us']);
  });

  it('accepts a file without the header', () => {
    assert.ok(parseNetscapeCookies('example.org\tFALSE\t/\tFALSE\t0\tname\tvalue').ok);
  });

  it('rejects lines with the wrong number of fields and reports the line', () => {
    assert.deepEqual(errorOf('# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t1\tname'), {
      code: ErrorCode.COOKIES_INVALID_FORMAT,
      line: 2
    });
    assert.deepEqual(errorOf('.x.com TRUE / TRUE 1 name value'), { code: ErrorCode.COOKIES_INVALID_FORMAT, line: 1 });
    assert.deepEqual(errorOf('a\tTRUE\t/\tTRUE\t1\tn\tv\textra'), { code: ErrorCode.COOKIES_INVALID_FORMAT, line: 1 });
  });

  it('rejects invalid booleans, expiry and empty fields', () => {
    assert.equal(errorOf('.x.com\tYES\t/\tTRUE\t1\tn\tv')?.line, 1);
    assert.equal(errorOf('.x.com\tTRUE\t/\tTRUE\tsoon\tn\tv')?.line, 1);
    assert.equal(errorOf('\tTRUE\t/\tTRUE\t1\tn\tv')?.line, 1);
    assert.equal(errorOf('.x.com\tTRUE\t\tTRUE\t1\tn\tv')?.line, 1);
  });

  it('requires at least one cookie line', () => {
    assert.deepEqual(errorOf('# Netscape HTTP Cookie File\n\n# nothing\n'), {
      code: ErrorCode.COOKIES_INVALID_FORMAT,
      line: 0
    });
    assert.equal(errorOf('')?.code, ErrorCode.COOKIES_INVALID_FORMAT);
    assert.equal(errorOf('{"cookies": []}')?.code, ErrorCode.COOKIES_INVALID_FORMAT);
  });

  it('limits size in bytes, not characters', () => {
    const line = 'x.com\tFALSE\t/\tFALSE\t0\tn\t';
    // Two-byte characters: within the limit in UTF-16 units, above it in bytes.
    const big = line + 'é'.repeat(LIMITS.maxCookieFileBytes / 2 + 10);
    assert.ok(big.length <= LIMITS.maxCookieFileBytes);
    assert.equal(errorOf(big)?.code, ErrorCode.COOKIES_TOO_LARGE);
  });

  it('caps the distinct domains at 20', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `.site${i}.test\tTRUE\t/\tFALSE\t0\tn\tv`);
    const result = parseNetscapeCookies(lines.join('\n'));
    assert.ok(result.ok);
    assert.equal(result.value.domains.length, 20);
    assert.equal(result.value.cookieCount, 30);
  });
});

describe('cookie names', () => {
  it('validates names used as file names', () => {
    for (const name of ['x.com.txt', 'my cookies (1).txt', 'a+b@c-d_e.txt']) assert.ok(isValidCookieName(name), name);
    for (const name of [
      'x.com',
      '../x.txt',
      'a/b.txt',
      'a\\b.txt',
      '.hidden.txt',
      'con.txt',
      'NUL.txt',
      'com1.log.txt',
      'x..txt',
      'é.txt',
      `${'a'.repeat(126)}.txt`,
      ' x.txt'
    ]) {
      const result = validateCookieName(name);
      assert.equal(result.ok, false, name);
      if (!result.ok) assert.equal(result.error.code, ErrorCode.COOKIES_INVALID_NAME);
    }
  });

  it('converts legacy file names into valid cookie names', () => {
    assert.equal(toCookieName('x.com.txt'), 'x.com.txt');
    assert.equal(toCookieName('reddit.cookies'), 'reddit.cookies.txt');
    assert.equal(toCookieName('Cookies Ünïcode!.TXT'), 'Cookies _n_code_.txt');
    assert.equal(toCookieName('.hidden.txt'), 'hidden.txt');
    assert.equal(toCookieName('con.txt'), null);
  });
});
