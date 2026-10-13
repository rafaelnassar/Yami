import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialSetupState, setupReducer, type SetupWizardEvent, type SetupWizardState } from './setup-wizard-model.ts';

const run = (state: SetupWizardState, ...events: SetupWizardEvent[]): SetupWizardState =>
  events.reduce(setupReducer, state);
const finished = (
  operationId: string,
  ok: boolean,
  kind: 'install' | 'update' | 'check-updates' | null = 'install'
): SetupWizardEvent => ({
  type: 'finished',
  operationId,
  ok,
  error: ok ? null : { code: 'TOOLS_INSTALL_FAILED' },
  kind
});

describe('setup wizard model', () => {
  it('opens on the chooser, or on the progress step while the host auto-installs', () => {
    assert.equal(initialSetupState(null).step, 'choose');
    assert.deepEqual(initialSetupState('op-auto'), {
      step: 'working',
      mode: 'standalone',
      operationId: 'op-auto',
      error: null
    });
  });

  it('follows the operation it started until that operation finishes', () => {
    let state = run(initialSetupState(null), { type: 'start', mode: 'python' });
    assert.deepEqual(state, { step: 'working', mode: 'python', operationId: null, error: null });
    state = run(state, finished('op-other', true));
    assert.equal(state.step, 'working', 'ignores completions while the id is unknown');
    state = run(state, { type: 'started', operationId: 'op-1' }, finished('op-other', true), finished('op-1', false));
    assert.equal(state.step, 'error');
    assert.deepEqual(state.error, { code: 'TOOLS_INSTALL_FAILED' });
  });

  it('Retry does not show the previous failure again', () => {
    let state = run(
      initialSetupState(null),
      { type: 'start', mode: 'standalone' },
      { type: 'started', operationId: 'op-1' },
      finished('op-1', false)
    );
    state = run(state, { type: 'retry' }, { type: 'start', mode: 'standalone' });
    // The stale `lastFinished` (op-1) is re-delivered when the component re-renders.
    state = run(state, finished('op-1', false));
    assert.equal(state.step, 'working');
    state = run(state, { type: 'started', operationId: 'op-2' }, finished('op-1', false));
    assert.equal(state.step, 'working');
    state = run(state, finished('op-2', true));
    assert.equal(state.step, 'done');
  });

  it('a stale successful update check never jumps to "done"', () => {
    const state = run(
      initialSetupState(null),
      { type: 'start', mode: 'standalone' },
      { type: 'started', operationId: 'op-1' },
      finished('op-check', true, 'check-updates')
    );
    assert.equal(state.step, 'working');
  });

  it('ignores non-install completions even with a matching id', () => {
    const state = run(initialSetupState('op-1'), finished('op-1', true, 'update'));
    assert.equal(state.step, 'working');
    assert.equal(run(state, finished('op-1', true, null)).step, 'done');
  });

  it('adopts a host install when the start is refused as busy, and fails otherwise', () => {
    const working = run(initialSetupState(null), { type: 'start', mode: 'standalone' });
    const adopted = run(working, { type: 'startFailed', error: { code: 'TOOLS_BUSY' }, hostInstallId: 'op-auto' });
    assert.equal(adopted.operationId, 'op-auto');
    assert.equal(run(adopted, finished('op-auto', true, null)).step, 'done');
    const busy = run(working, { type: 'startFailed', error: { code: 'TOOLS_BUSY' }, hostInstallId: null });
    assert.equal(busy.step, 'error');
    const failed = run(working, {
      type: 'startFailed',
      error: { code: 'TOOLS_NETWORK_FAILED' },
      hostInstallId: 'op-auto'
    });
    assert.deepEqual(failed.error, { code: 'TOOLS_NETWORK_FAILED' });
  });

  it('adopts a host install shown on the chooser, but not over a finished result', () => {
    assert.equal(run(initialSetupState(null), { type: 'hostInstall', operationId: 'op-auto' }).operationId, 'op-auto');
    const done = run(initialSetupState('op-1'), finished('op-1', true));
    assert.equal(run(done, { type: 'hostInstall', operationId: 'op-2' }).step, 'done');
    const ours = run(
      initialSetupState(null),
      { type: 'start', mode: 'standalone' },
      { type: 'started', operationId: 'op-1' }
    );
    assert.equal(run(ours, { type: 'hostInstall', operationId: 'op-9' }).operationId, 'op-1');
  });
});
