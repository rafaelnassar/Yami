import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DownloadProgressDto, HostStateDto } from '../../../shared/contracts/dto.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import { taskbarProgress, trayTooltip, type ShellState } from './shell-status.ts';

function state(overrides: {
  status: HostStateDto['status'];
  active?: DownloadProgressDto[];
  batch?: HostStateDto['downloads']['batch'];
}): ShellState {
  return {
    status: overrides.status,
    downloads: { active: overrides.active ?? [], queued: [], batch: overrides.batch ?? null }
  };
}

const download = (percent: number | null): DownloadProgressDto => ({
  conversationId: 'c',
  batchId: null,
  engine: 'yt-dlp',
  scope: 'single',
  sourceUrl: 'https://a.b',
  status: 'running',
  counters: { done: 0, skipped: 0, errors: 0 },
  percent,
  speed: null,
  eta: null,
  currentFile: null,
  startedAt: 1
});

describe('trayTooltip', () => {
  const t = translatorFor('pt');
  it('reflects connection status first, then download activity', () => {
    assert.equal(trayTooltip({ state: 'offline', error: null }, null, t), 'Yami — motor de downloads offline');
    assert.equal(
      trayTooltip({ state: 'restarting', attempt: 1, error: null }, null, t),
      'Yami — reiniciando o motor de downloads…'
    );
    assert.equal(
      trayTooltip({ state: 'ready' }, state({ status: 'running', active: [download(1), download(2)] }), t),
      'Yami — 2 downloads em andamento'
    );
    assert.equal(
      trayTooltip({ state: 'ready' }, state({ status: 'running', active: [download(1)] }), t),
      'Yami — 1 download em andamento'
    );
    assert.equal(trayTooltip({ state: 'ready' }, state({ status: 'paused' }), t), 'Yami — downloads pausados');
    assert.equal(trayTooltip({ state: 'ready' }, state({ status: 'idle' }), t), 'Yami');
  });
});

describe('taskbarProgress', () => {
  it('prefers batch progress, then a single percent, else indeterminate', () => {
    assert.deepEqual(taskbarProgress(null), { value: -1, mode: 'none' });
    assert.deepEqual(taskbarProgress(state({ status: 'idle' })), { value: -1, mode: 'none' });
    const batch = {
      batchId: 'b',
      engine: 'gallery-dl' as const,
      total: 4,
      finished: 1,
      counters: { done: 0, skipped: 0, errors: 0 }
    };
    assert.deepEqual(taskbarProgress(state({ status: 'running', batch, active: [download(90)] })), {
      value: 0.25,
      mode: 'normal'
    });
    assert.deepEqual(taskbarProgress(state({ status: 'running', active: [download(40)] })), {
      value: 0.4,
      mode: 'normal'
    });
    assert.deepEqual(taskbarProgress(state({ status: 'running', active: [download(null)] })), {
      value: 1,
      mode: 'indeterminate'
    });
    assert.deepEqual(taskbarProgress(state({ status: 'paused', active: [download(40)] })), {
      value: 0.4,
      mode: 'paused'
    });
  });
});
