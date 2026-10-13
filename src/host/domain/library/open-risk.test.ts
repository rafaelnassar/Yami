import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUNDLE_DIRECTORY_EXTENSIONS,
  directoryOpenRisk,
  entryOpenRisk,
  isLaunchableDirectoryName
} from './open-risk.ts';

describe('directory open risk', () => {
  it('blocks every macOS bundle/installer extension, case-insensitively', () => {
    for (const ext of BUNDLE_DIRECTORY_EXTENSIONS) {
      assert.equal(directoryOpenRisk(`Evil${ext}`), 'blocked', ext);
      assert.equal(directoryOpenRisk(`Evil${ext.toUpperCase()}`), 'blocked', ext.toUpperCase());
    }
    assert.equal(directoryOpenRisk('Photo Booth.App'), 'blocked');
    assert.equal(directoryOpenRisk('.app'), 'blocked');
  });

  it('blocks Windows CLSID junction folders', () => {
    assert.equal(directoryOpenRisk('Control.{21EC2020-3AEA-1069-A2DD-08002B30309D}'), 'blocked');
    assert.equal(directoryOpenRisk('x.{645ff040-5081-101b-9f08-00aa002f954e}'), 'blocked');
    assert.equal(directoryOpenRisk('.{645FF040-5081-101B-9F08-00AA002F954E}'), 'blocked');
  });

  it('ignores trailing dots and spaces that Windows strips', () => {
    assert.equal(directoryOpenRisk('Evil.app.'), 'blocked');
    assert.equal(directoryOpenRisk('Evil.app . '), 'blocked');
    assert.equal(directoryOpenRisk('x.{645FF040-5081-101B-9F08-00AA002F954E} '), 'blocked');
  });

  it('keeps ordinary folders safe, including executable-looking names', () => {
    for (const name of ['album', 'gallery-dl', 'album.exe', 'my.apps', 'app', 'Evil.app.backup', 'v1.2', '']) {
      assert.equal(directoryOpenRisk(name), 'safe', name);
    }
    // Not a well-formed CLSID: no dot, wrong length, not hex.
    const malformed = [
      '{645FF040-5081-101B-9F08-00AA002F954E}',
      'x.{645FF040-5081-101B-9F08-00AA002F954}',
      'x.{zzzzzzzz-5081-101b-9f08-00aa002f954e}'
    ];
    for (const name of malformed) assert.equal(isLaunchableDirectoryName(name), false, name);
  });

  it('delegates files to the shared extension policy', () => {
    assert.equal(entryOpenRisk('clip.mp4', false), 'safe');
    assert.equal(entryOpenRisk('setup.exe', false), 'blocked');
    assert.equal(entryOpenRisk('notes', false), 'caution');
    assert.equal(entryOpenRisk('Evil.app', true), 'blocked');
    assert.equal(entryOpenRisk('setup.exe', true), 'safe');
  });
});
