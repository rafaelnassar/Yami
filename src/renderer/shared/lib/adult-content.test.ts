import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hintKey, isAdultHint, shouldBlurMedia } from './adult-content.ts';

describe('adult blur policy', () => {
  it('matches known adult hosts in URLs', () => {
    assert.equal(isAdultHint('https://rule34.xxx/index.php?page=post'), true);
    assert.equal(isAdultHint('https://danbooru.donmai.us/posts/1'), true);
    assert.equal(isAdultHint('https://www.youtube.com/watch?v=1'), false);
  });

  it('matches gallery-dl folders in local paths (both separators)', () => {
    assert.equal(isAdultHint('C:\\Users\\a\\Downloads\\gallery-dl\\rule34.xxx\\tag\\1.jpg'), true);
    assert.equal(isAdultHint('/home/a/dl/gallery-dl/e621/pool/2.png'), true);
    assert.equal(isAdultHint('/home/a/dl/gallery-dl/twitter/user/3.jpg'), false);
  });

  it('does not match words that merely contain a token', () => {
    assert.equal(isAdultHint('/dl/gallery-dl/artstation/tbibliography/1.jpg'), false);
    assert.equal(isAdultHint(''), false);
    assert.equal(isAdultHint(null), false);
  });

  it('blurs only when enabled and any hint matches', () => {
    const hints = ['/dl/gallery-dl/twitter/a.jpg', 'https://e621.net/posts/1'];
    assert.equal(shouldBlurMedia(true, hints), true);
    assert.equal(shouldBlurMedia(false, hints), false);
    assert.equal(shouldBlurMedia(true, ['/dl/yt-dlp/youtube/v.mp4']), false);
  });

  it('builds a stable identity ignoring empty hints', () => {
    assert.equal(hintKey(['a', null, undefined, '', 'b']), 'a\nb');
  });
});
