import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeProgressDto } from '../../../../shared/contracts/dto.ts';
import { createManualScheduler } from '../../../shared/testing/manual-scheduler.ts';
import { createRuntimeStore, PROGRESS_CLEAR_MS } from './runtime-store.ts';

const progress = (operationId: string, percent: number | null): RuntimeProgressDto => ({
  operationId,
  tool: 'yt-dlp',
  phase: 'download',
  code: 'download',
  params: {},
  percent,
  step: 1,
  totalSteps: 2,
  ts: 1
});

describe('runtime store', () => {
  it('reports the kind only for operations started in this window', () => {
    const store = createRuntimeStore({ scheduler: createManualScheduler() });
    store.getState().track('op-1', 'install');
    assert.equal(store.getState().receiveFinished('op-1', true, null).kind, 'install');
    assert.equal(store.getState().receiveFinished('op-2', true, null).kind, null);
    assert.deepEqual(store.getState().started, {});
  });

  it('clears a successful progress box after a delay unless a new operation reports', () => {
    const scheduler = createManualScheduler();
    const store = createRuntimeStore({ scheduler });
    store.getState().receiveProgress(progress('op-1', 100));
    store.getState().receiveFinished('op-1', true, null);
    scheduler.advance(PROGRESS_CLEAR_MS - 1);
    assert.equal(store.getState().progress?.operationId, 'op-1');
    scheduler.advance(1);
    assert.equal(store.getState().progress, null);

    store.getState().receiveProgress(progress('op-2', 100));
    store.getState().receiveFinished('op-2', true, null);
    store.getState().receiveProgress(progress('op-3', 10));
    scheduler.advance(PROGRESS_CLEAR_MS);
    assert.equal(store.getState().progress?.operationId, 'op-3');
  });

  it('keeps failed progress visible', () => {
    const scheduler = createManualScheduler();
    const store = createRuntimeStore({ scheduler });
    store.getState().receiveProgress(progress('op-1', 40));
    store.getState().receiveFinished('op-1', false, { code: 'TOOLS_INSTALL_FAILED' });
    scheduler.advance(PROGRESS_CLEAR_MS * 2);
    assert.equal(store.getState().progress?.operationId, 'op-1');
    assert.deepEqual(store.getState().lastFinished?.error, { code: 'TOOLS_INSTALL_FAILED' });
  });
});
