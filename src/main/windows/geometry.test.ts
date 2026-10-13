import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampToWorkArea, placePanelNearTray } from './geometry.ts';

const work = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 420, height: 148 };

describe('clampToWorkArea', () => {
  it('leaves fitting windows alone and pulls off-screen ones back', () => {
    assert.equal(
      clampToWorkArea({ x: 100, y: 100, width: 1280, height: 800 }, work, { width: 960, height: 620 }),
      null
    );
    assert.deepEqual(
      clampToWorkArea({ x: 1500, y: -50, width: 1280, height: 800 }, work, { width: 960, height: 620 }),
      {
        x: 640,
        y: 0,
        width: 1280,
        height: 800
      }
    );
    const small = { x: 0, y: 0, width: 800, height: 600 };
    assert.deepEqual(
      clampToWorkArea({ x: 0, y: 0, width: 1280, height: 800 }, small, { width: 960, height: 620 }),
      small
    );
  });
});

describe('placePanelNearTray', () => {
  it('sits above a bottom taskbar tray icon', () => {
    const placement = placePanelNearTray({
      trayBounds: { x: 1800, y: 1045, width: 24, height: 24 },
      cursor: { x: 0, y: 0 },
      work,
      size
    });
    assert.equal(placement.anchor, 'above');
    assert.equal(placement.y, 1040 - 148 - 6);
    assert.equal(placement.x, 1920 - 420 - 6);
  });

  it('flips below a top menu-bar icon', () => {
    const placement = placePanelNearTray({
      trayBounds: { x: 900, y: 0, width: 22, height: 22 },
      cursor: { x: 0, y: 0 },
      work: { ...work, y: 25 },
      size
    });
    assert.equal(placement.anchor, 'below');
    // tray bottom (22) + 6, then kept 6 px inside the work area that starts below the menu bar.
    assert.equal(placement.y, 31);
    assert.equal(placement.x, Math.round(911 - 210));
  });

  it('falls back to the cursor and the work-area bottom without tray bounds (Linux)', () => {
    const placement = placePanelNearTray({
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      cursor: { x: 10, y: 500 },
      work,
      size
    });
    assert.deepEqual(placement, { x: 6, y: 1040 - 148 - 6, anchor: 'above' });
  });
});
