import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AVATAR_COLORS, siteAvatar, siteBrand, siteFaviconUrl, siteLabel } from './site.ts';

describe('site helpers', () => {
  it('labels URLs by host without www', () => {
    assert.equal(siteLabel('https://www.pixiv.net/artworks/1'), 'pixiv.net');
    assert.equal(siteLabel('not a url/path'), 'not a url');
    assert.equal(siteLabel(''), '');
  });

  it('extracts the brand part of a host', () => {
    assert.equal(siteBrand('x.com'), 'x');
    assert.equal(siteBrand('www.bbc.co.uk'), 'bbc');
    assert.equal(siteBrand('danbooru.donmai.us'), 'donmai');
    assert.equal(siteBrand('localhost'), 'localhost');
  });

  it('gives a deterministic letter + palette colour', () => {
    const a = siteAvatar('pixiv.net');
    assert.equal(a.letter, 'P');
    assert.ok(AVATAR_COLORS.includes(a.color));
    assert.deepEqual(siteAvatar('pixiv.net'), a);
    assert.equal(siteAvatar('').letter, '?');
  });

  it('builds the Google favicon URL from the host only', () => {
    assert.equal(
      siteFaviconUrl('www.pixiv.net', 32),
      'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https%3A%2F%2Fpixiv.net%2F&size=32'
    );
    assert.equal(siteFaviconUrl('', 32), null);
    assert.equal(siteFaviconUrl('not valid host!', 32), null);
  });
});
