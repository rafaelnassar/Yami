import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';
import { ErrorCode, appError } from '../../shared/kernel/errors.ts';
import { FakeTimers } from '../infrastructure/fake-timers.ts';
import { nullLogger } from '../infrastructure/logger.ts';
import {
  SMOKE_FLAG,
  parseSmokeFlag,
  runSmokeTest,
  smokeSandbox,
  toRendererProbe,
  type RendererProbe,
  type SmokeResult
} from './smoke-test.ts';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function setup(options: { probes?: RendererProbe[]; loaded?: Promise<void>; status?: HostConnectionStatus } = {}) {
  const timers = new FakeTimers();
  let status: HostConnectionStatus = options.status ?? { state: 'starting' };
  const statusListeners = new Set<(status: HostConnectionStatus) => void>();
  const goneListeners = new Set<(reason: string) => void>();
  const probes = [...(options.probes ?? [{ bridge: true, mounted: true, crashed: false }])];
  const results: SmokeResult[] = [];
  const outcome: string[] = [];
  runSmokeTest({
    rendererLoaded: () => options.loaded ?? Promise.resolve(),
    probeRenderer: async () => probes.shift() ?? { bridge: true, mounted: true, crashed: false },
    hostStatus: () => status,
    onHostStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onRendererGone: (listener) => {
      goneListeners.add(listener);
      return () => goneListeners.delete(listener);
    },
    timers,
    now: () => timers.now,
    logger: nullLogger,
    report: (result) => results.push(result),
    pass: () => outcome.push('pass'),
    fail: () => outcome.push('fail'),
    timeoutMs: 10_000
  });
  const setStatus = (next: HostConnectionStatus): void => {
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };
  const crashRenderer = (reason: string): void => {
    for (const listener of [...goneListeners]) listener(reason);
  };
  return { timers, results, outcome, setStatus, crashRenderer, statusListeners };
}

describe('parseSmokeFlag', () => {
  it('is null without the flag and ignores similar arguments', () => {
    assert.equal(parseSmokeFlag(['Yami.exe', '--inspect', `${SMOKE_FLAG}s`]), null);
  });
  it('accepts the bare flag and the =<dir> form', () => {
    assert.deepEqual(parseSmokeFlag(['Yami.exe', SMOKE_FLAG]), { dir: null });
    assert.deepEqual(parseSmokeFlag(['Yami.exe', `${SMOKE_FLAG}=C:\\temp\\smoke`]), { dir: 'C:\\temp\\smoke' });
    assert.deepEqual(parseSmokeFlag(['Yami.exe', `${SMOKE_FLAG}=  `]), { dir: null });
  });
});

describe('smokeSandbox', () => {
  it('keeps every redirected path inside the sandbox root', () => {
    const root = path.resolve('smoke-root');
    const sandbox = smokeSandbox(root, 'Yami');
    for (const value of [...Object.values(sandbox.paths), ...Object.values(sandbox.env)]) {
      const relative = path.relative(root, value);
      assert.ok(relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative), value);
    }
    assert.equal(path.basename(sandbox.paths.userData), 'Yami');
  });
});

describe('toRendererProbe', () => {
  it('only accepts literal true values', () => {
    assert.deepEqual(toRendererProbe({ bridge: true, mounted: true, crashed: false }), {
      bridge: true,
      mounted: true,
      crashed: false
    });
    assert.deepEqual(toRendererProbe({ bridge: 'yes', mounted: 1, crashed: 'no' }), {
      bridge: false,
      mounted: false,
      crashed: false
    });
    assert.deepEqual(toRendererProbe(null), { bridge: false, mounted: false, crashed: false });
  });
});

describe('runSmokeTest', () => {
  it('passes once the renderer mounted and the host is ready, in any order', async () => {
    const run = setup({ probes: [{ bridge: true, mounted: false, crashed: false }] });
    await flush();
    assert.deepEqual(run.outcome, []);
    run.timers.advance(250);
    await flush();
    assert.deepEqual(run.outcome, [], 'renderer ready but host still starting');
    run.setStatus({ state: 'ready' });
    assert.deepEqual(run.outcome, ['pass']);
    assert.equal(run.results[0]?.ok, true);
    assert.equal(run.timers.pending, 0, 'timeout and probes are cancelled');
    assert.equal(run.statusListeners.size, 0);
  });

  it('passes immediately when the host was already ready', async () => {
    const run = setup({ status: { state: 'ready' } });
    await flush();
    assert.deepEqual(run.outcome, ['pass']);
  });

  it('fails when the preload bridge never shows up', async () => {
    const run = setup({
      status: { state: 'ready' },
      probes: Array.from({ length: 100 }, () => ({ bridge: false, mounted: true, crashed: false }))
    });
    for (let i = 0; i < 40; i += 1) {
      run.timers.advance(250);
      await flush();
    }
    assert.deepEqual(run.outcome, ['fail']);
    assert.match(run.results[0]?.reason ?? '', /timeout after 10000 ms: renderer not ready/);
  });

  it('fails when a panel crashed into an error boundary, even though React mounted', async () => {
    const run = setup({ status: { state: 'ready' }, probes: [{ bridge: true, mounted: true, crashed: true }] });
    await flush();
    assert.deepEqual(run.outcome, ['fail']);
    assert.match(run.results[0]?.reason ?? '', /error boundary/);
  });

  it('fails as soon as the host crashes or goes offline', async () => {
    const run = setup();
    await flush();
    run.setStatus({ state: 'restarting', attempt: 1, error: appError(ErrorCode.HOST_UNAVAILABLE) });
    assert.deepEqual(run.outcome, ['fail']);
    assert.match(run.results[0]?.reason ?? '', /host restarting \(HOST_UNAVAILABLE\)/);
    run.setStatus({ state: 'ready' });
    assert.deepEqual(run.outcome, ['fail'], 'settles only once');
  });

  it('fails when the main frame fails to load or the renderer crashes', async () => {
    const failedLoad = setup({ loaded: Promise.reject(new Error('ERR_FILE_NOT_FOUND')) });
    await flush();
    assert.deepEqual(failedLoad.outcome, ['fail']);
    assert.match(failedLoad.results[0]?.reason ?? '', /renderer failed to load: ERR_FILE_NOT_FOUND/);

    const crashed = setup({ loaded: new Promise(() => undefined) });
    crashed.crashRenderer('crashed');
    assert.deepEqual(crashed.outcome, ['fail']);
    assert.match(crashed.results[0]?.reason ?? '', /renderer process gone \(crashed\)/);
  });

  it('reports a timeout with what was still pending', async () => {
    const run = setup({ loaded: new Promise(() => undefined) });
    run.timers.advance(10_000);
    await flush();
    assert.deepEqual(run.outcome, ['fail']);
    assert.equal(run.results[0]?.reason, 'timeout after 10000 ms: host starting, renderer not ready');
  });
});
