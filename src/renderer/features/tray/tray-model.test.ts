import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canSubmitTray, trayStatus, trayWindowHeight } from './tray-model.ts';

const input = { phase: 'idle', ready: true, engineAvailable: true, url: 'https://example.com/a' } as const;

describe('tray model', () => {
  it('prioritizes error, then waiting, then missing engine, then invalid URL', () => {
    assert.deepEqual(trayStatus({ ...input, phase: 'error', ready: false }), { kind: 'error' });
    assert.deepEqual(trayStatus({ ...input, ready: false }), { kind: 'waiting' });
    assert.deepEqual(trayStatus({ ...input, engineAvailable: false }), { kind: 'engine-missing' });
    assert.deepEqual(trayStatus({ ...input, url: 'nope' }), { kind: 'invalid-url' });
    assert.equal(trayStatus(input), null);
    assert.equal(trayStatus({ ...input, url: '   ' }), null);
  });

  it('requires a ready host for every submit path (Enter included)', () => {
    assert.equal(canSubmitTray(input), true);
    assert.equal(canSubmitTray({ ...input, ready: false }), false);
    assert.equal(canSubmitTray({ ...input, phase: 'starting' }), false);
    assert.equal(canSubmitTray({ ...input, url: 'ftp://x' }), false);
  });

  it('clamps the popup height to the IPC bounds', () => {
    assert.equal(trayWindowHeight(10), 80);
    assert.equal(trayWindowHeight(150.2), 151);
    assert.equal(trayWindowHeight(5000), 720);
  });
});
