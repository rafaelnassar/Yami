import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { browseList, createPreviewStore, siblingOf, type MediaRef } from './preview-store.ts';
import { clampPan, clampZoom, zoomFromWheel } from './zoom-math.ts';

const ref = (path: string, mediaType: MediaRef['mediaType']): MediaRef => ({
  path,
  name: path,
  mediaType,
  sizeBytes: null,
  ts: 0
});

describe('preview browsing', () => {
  const scope = [ref('/1.jpg', 'image'), ref('/2.mp4', 'video'), ref('/3.jpg', 'image'), ref('/4.mp3', 'audio')];

  it('browses among files of the same kind with wrap-around', () => {
    assert.deepEqual(
      browseList(scope, scope[0] ?? null).items.map((item) => item.path),
      ['/1.jpg', '/3.jpg']
    );
    assert.equal(siblingOf(scope, scope[2] ?? null, 1)?.path, '/1.jpg');
    assert.equal(siblingOf(scope, scope[0] ?? null, -1)?.path, '/3.jpg');
    assert.equal(siblingOf(scope, scope[1] ?? null, 1), null);
    assert.deepEqual(browseList(scope, scope[3] ?? null), { items: [], index: -1 });
  });

  it('closes when the previewed file is deleted and remembers volume', () => {
    const store = createPreviewStore();
    store.getState().open(scope[0] ?? ref('/x', 'image'), scope);
    store.getState().removePaths(['/1.jpg']);
    assert.equal(store.getState().current, null);
    store.getState().rememberVolume(0);
    store.getState().rememberVolume(0.4);
    assert.equal(store.getState().volume, 0.4);
  });
});

describe('zoom math', () => {
  it('clamps zoom and pan', () => {
    assert.equal(clampZoom(5), 3);
    assert.equal(clampZoom(0.2), 1);
    assert.equal(zoomFromWheel(1, -100), 1.15);
    assert.equal(zoomFromWheel(1, 100), 1);
    assert.deepEqual(clampPan(50, 50, 1, 100, 100, 100, 100), { x: 0, y: 0 });
    assert.deepEqual(clampPan(500, -500, 2, 100, 100, 100, 100), { x: 25, y: -25 });
  });
});
