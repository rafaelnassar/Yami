import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { watchDownloadDir } from './download-dir-watch.ts';
import { MediaRegistry } from './media-registry.ts';

const identity = { realPath: '/old/a.mp4', dev: 1n, ino: 7n, size: 1, mtimeNs: 1n };

describe('watchDownloadDir', () => {
  it('fires on changes only, not on the first value or repeats', () => {
    let changes = 0;
    const observe = watchDownloadDir(() => (changes += 1));
    observe('/old');
    observe('/old');
    assert.equal(changes, 0);
    observe('/new');
    observe('/new');
    assert.equal(changes, 1);
    observe('/old');
    assert.equal(changes, 2);
  });

  it('revokes every media token (thumbnails included) when wired to the registry', () => {
    const registry = new MediaRegistry({ now: () => 0 });
    const observe = watchDownloadDir(() => registry.clear());
    observe('/old');
    const video = registry.register({ path: '/old/a.mp4', mime: 'video/mp4', name: 'a.mp4', identity });
    const thumb = registry.register({
      path: '/cache/thumbs/a.png',
      mime: 'image/png',
      name: 'a.mp4',
      identity: { ...identity, realPath: '/cache/thumbs/a.png' }
    });
    observe('/old');
    assert.ok(registry.resolve(video));
    observe('/new');
    assert.equal(registry.resolve(video), null);
    assert.equal(registry.resolve(thumb), null);
    assert.equal(registry.size, 0);
  });
});
