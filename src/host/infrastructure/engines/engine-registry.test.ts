import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GalleryDlAdapter } from './gallery-dl/gallery-dl-adapter.ts';
import { StaticEngineRegistry, createEngineRegistry } from './engine-registry.ts';
import { isYouTubeUrl } from './url-rules.ts';

describe('slotWeight', () => {
  it('weights gallery-dl lighter than yt-dlp', () => {
    const registry = createEngineRegistry();
    assert.equal(registry.get('gallery-dl').slotWeight, 1);
    assert.equal(registry.get('yt-dlp').slotWeight, 2);
    assert.equal(registry.slotWeightOf('unknown'), 1);
    assert.equal(registry.slotWeightOf('yt-dlp'), 2);
  });
});

describe('StaticEngineRegistry', () => {
  it('returns the adapter of each engine', () => {
    const registry = createEngineRegistry();
    assert.equal(registry.get('gallery-dl').engine, 'gallery-dl');
    assert.equal(registry.get('yt-dlp').engine, 'yt-dlp');
  });

  it('rejects incomplete or duplicated registrations', () => {
    assert.throws(() => new StaticEngineRegistry([new GalleryDlAdapter()]), /Missing engine adapters: yt-dlp/);
    assert.throws(
      () => new StaticEngineRegistry([new GalleryDlAdapter(), new GalleryDlAdapter()]),
      /registered twice: gallery-dl/
    );
  });

  it('passes gallery-dl options through the factory', () => {
    const registry = createEngineRegistry({ galleryDl: { delegateVideosToYtdl: () => true } });
    const args = registry.get('gallery-dl').buildInvocation({
      url: 'https://www.reddit.com/r/x',
      downloadDir: '/d/gallery-dl',
      tempDir: '/w/tmp',
      executable: { path: '/bin/gallery-dl', prefixArgs: [] },
      ffmpegPath: null,
      denoPath: null,
      cookieFile: null,
      browserCookies: null,
      secretConfigFile: null,
      platform: 'linux'
    }).args;
    assert.ok(args.includes('extractor.reddit.videos=dash'));
    assert.ok(args.includes('extractor.fanbox.embeds=ytdl'));
    assert.ok(args.includes('extractor.facebook.videos=ytdl'));
  });
});

describe('YouTube browser cookies', () => {
  it('detects YouTube hosts', () => {
    assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=1'), true);
    assert.equal(isYouTubeUrl('https://youtu.be/abc'), true);
    assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=1'), true);
    assert.equal(isYouTubeUrl('https://xvideos.com/video'), false);
  });

  // The opt-in itself is a downloads-core policy; the engine side decides which
  // engine can use browser cookies at all (yt-dlp, on every site).
  it('does not force browser cookies for YouTube unless the user opted in', () => {
    const registry = createEngineRegistry();
    assert.equal(registry.get('gallery-dl').supportsBrowserCookies('https://youtu.be/abc'), false);
    assert.equal(registry.get('yt-dlp').supportsBrowserCookies('https://youtu.be/abc'), true);
    assert.equal(registry.get('yt-dlp').supportsBrowserCookies('https://x.com/a'), true);
  });
});
