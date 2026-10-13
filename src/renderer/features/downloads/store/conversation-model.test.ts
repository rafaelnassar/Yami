import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FolderDto } from '../../../../shared/contracts/dto.ts';
import { hostState, mediaFile, progress, summary } from '../../../shared/testing/fixtures.ts';
import {
  countNounFor,
  effectiveStatus,
  groupByFolder,
  isRestartableStatus,
  isWorkingStatus,
  liveProgressOf,
  mosaicFiles
} from './conversation-model.ts';

const folder = (id: string): FolderDto => ({
  id,
  name: id,
  color: '#94A3B8',
  collapsed: false,
  position: 0,
  createdAt: 0
});

describe('conversation model', () => {
  it('looks up progress for ONE conversation (not the global batch)', () => {
    const state = hostState({
      active: [progress('a', { percent: 10 }), progress('b', { percent: 90 })],
      queued: [
        { conversationId: 'c', sourceUrl: '', engine: 'yt-dlp', scope: 'single', status: 'pending' },
        { conversationId: 'd', sourceUrl: '', engine: 'yt-dlp', scope: 'single', status: 'paused' }
      ]
    });
    const a = liveProgressOf(state, 'a');
    assert.equal(a?.percent, 10);
    assert.equal(a?.kind, 'running');
    assert.deepEqual(liveProgressOf(state, 'd'), {
      kind: 'queued',
      status: 'paused',
      position: 2,
      done: 0,
      skipped: 0,
      errors: 0,
      percent: null,
      speed: null,
      eta: null,
      currentFile: null
    });
    assert.equal(liveProgressOf(state, 'zzz'), null);
    assert.equal(liveProgressOf(null, 'a'), null);
  });

  it('returns a flat record that is shallow-equal across snapshots with unchanged progress', () => {
    const first = liveProgressOf(hostState({ active: [progress('a'), progress('b', { percent: 1 })] }), 'a');
    const second = liveProgressOf(hostState({ active: [progress('a'), progress('b', { percent: 2 })] }), 'a');
    assert.ok(first && second);
    for (const value of Object.values(first)) assert.notEqual(typeof value, 'object');
    assert.deepEqual(first, second);
  });

  it('prefers the live status over the persisted summary', () => {
    const state = hostState({
      active: [progress('a', { status: 'running' })],
      queued: [{ conversationId: 'q', sourceUrl: '', engine: 'yt-dlp', scope: 'single', status: 'paused' }]
    });
    assert.equal(effectiveStatus('completed', null), 'completed');
    assert.equal(effectiveStatus('pending', liveProgressOf(state, 'a')), 'running');
    assert.equal(effectiveStatus('running', liveProgressOf(state, 'q')), 'paused');
  });

  it('groups conversations by existing folders in O(n)', () => {
    const groups = groupByFolder(
      [
        summary('a', { folderId: 'f1' }),
        summary('b'),
        summary('c', { folderId: 'gone' }),
        summary('d', { folderId: 'f1' })
      ],
      [folder('f1'), folder('f2')]
    );
    assert.deepEqual(
      groups.byFolder.get('f1')?.map((item) => item.id),
      ['a', 'd']
    );
    assert.deepEqual(groups.byFolder.get('f2'), []);
    assert.deepEqual(
      groups.unfiled.map((item) => item.id),
      ['b', 'c']
    );
  });

  it('status predicates and mosaic selection', () => {
    assert.equal(isWorkingStatus('pending'), true);
    assert.equal(isWorkingStatus('paused'), false);
    assert.equal(isRestartableStatus('cancelled'), true);
    assert.equal(isRestartableStatus('running'), false);
    const files = [mediaFile(1, '/a.txt'), mediaFile(2, '/b.jpg'), mediaFile(3, '/c.mp4')];
    assert.deepEqual(
      mosaicFiles(files, 5).map((file) => file.id),
      [2, 3]
    );
    assert.deepEqual(
      mosaicFiles([mediaFile(1, '/a.txt')], 5).map((file) => file.id),
      [1]
    );
    assert.equal(countNounFor('document'), 'file');
    assert.equal(countNounFor('video'), 'video');
  });
});
