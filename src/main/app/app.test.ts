import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nullLogger } from '../infrastructure/logger.ts';
import { COMMAND_SPECS } from '../../shared/contracts/host-protocol.ts';
import { DEFAULT_EXIT_WATCHDOG_MS, DEFAULT_HOST_SHUTDOWN_CAP_MS, QuitCoordinator } from './quit-coordinator.ts';
import { RendererRecovery } from './renderer-recovery.ts';

describe('QuitCoordinator', () => {
  function setup(shutdownHost: () => Promise<void> = async () => undefined, exitWatchdogMs = 1_000) {
    const steps: string[] = [];
    const quit = new QuitCoordinator({
      stopBackgroundWork: () => steps.push('stop'),
      shutdownHost: async () => {
        steps.push('host');
        await shutdownHost();
      },
      exit: () => steps.push('exit'),
      forceExit: () => steps.push('force-exit'),
      logger: nullLogger,
      hostTimeoutMs: 50,
      exitWatchdogMs
    });
    const event = () => {
      let prevented = false;
      return {
        preventDefault: () => (prevented = true),
        get prevented() {
          return prevented;
        }
      };
    };
    return { quit, steps, event };
  }

  it('prevents the first before-quit, shuts the host down, then exits', async () => {
    const { quit, steps, event } = setup();
    const first = event();
    quit.onBeforeQuit(first);
    assert.equal(first.prevented, true);
    assert.equal(quit.isQuitting, true);
    const duplicate = event();
    quit.onBeforeQuit(duplicate);
    assert.equal(duplicate.prevented, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(steps, ['stop', 'host', 'exit']);
    const late = event();
    quit.onBeforeQuit(late);
    assert.equal(late.prevented, false);
  });

  it('hides everything synchronously, before waiting for the host', () => {
    const { quit, steps } = setup(() => new Promise(() => undefined));
    quit.quit();
    // No await yet: windows are gone the moment quitting starts.
    assert.deepEqual(steps, ['stop', 'host']);
  });

  it('does not wait forever for a hung host and supports a custom final step', async () => {
    const { quit, steps } = setup(() => new Promise(() => undefined));
    let installed = false;
    quit.quit(() => {
      installed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(steps, ['stop', 'host']);
    assert.equal(installed, true);
  });

  it('forces the exit when the final step throws or does not end the process', async () => {
    const throwing = setup();
    throwing.quit.quit(() => {
      throw new Error('installer missing');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(throwing.steps, ['stop', 'host', 'force-exit']);

    const stalled = setup(async () => undefined, 30);
    stalled.quit.quit(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(stalled.steps, ['stop', 'host']);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(stalled.steps, ['stop', 'host', 'force-exit']);
  });

  it('waits longer than the host-side stop deadline, but boundedly', () => {
    const hostNeedsMs = 15_000;
    const mainTimeoutMs = COMMAND_SPECS['lifecycle.shutdown'].timeoutMs;
    assert.ok(mainTimeoutMs > hostNeedsMs);
    assert.ok(DEFAULT_HOST_SHUTDOWN_CAP_MS > mainTimeoutMs);
    assert.ok(DEFAULT_HOST_SHUTDOWN_CAP_MS + DEFAULT_EXIT_WATCHDOG_MS <= 60_000);
  });
});

describe('RendererRecovery', () => {
  it('reloads at most 3 times per minute per window with growing delays', () => {
    let now = 0;
    const recovery = new RendererRecovery(() => now);
    assert.deepEqual(recovery.onGone('main', 'crashed'), { reload: true, delayMs: 500 });
    assert.deepEqual(recovery.onGone('main', 'oom'), { reload: true, delayMs: 2_000 });
    assert.deepEqual(recovery.onGone('main', 'crashed'), { reload: true, delayMs: 5_000 });
    assert.deepEqual(recovery.onGone('main', 'crashed'), { reload: false });
    assert.deepEqual(recovery.onGone('tray', 'crashed'), { reload: true, delayMs: 500 });
    assert.deepEqual(recovery.onGone('tray', 'clean-exit'), { reload: false });
    now = 60_001;
    assert.deepEqual(recovery.onGone('main', 'crashed'), { reload: true, delayMs: 500 });
  });
});
