import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UpdateStatus } from '../../../shared/contracts/ipc.ts';
import { FakeTimers } from '../../infrastructure/fake-timers.ts';
import { nullLogger } from '../../infrastructure/logger.ts';
import { Updater, isPortableBuild, type UpdaterEngine } from './updater.ts';

class FakeEngine implements UpdaterEngine {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  checks = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  readonly #listeners = new Map<string, Array<(value: unknown) => void>>();
  on(event: string, listener: (arg: never) => void): this {
    // Test double: events are emitted with the payload shape each listener expects.
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener as (value: unknown) => void]);
    return this;
  }
  emit(event: string, arg?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(arg);
  }
  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    this.emit('checking-for-update');
    return null;
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function setup(options: { packaged?: boolean; portable?: boolean; auto?: boolean; engine?: FakeEngine | null } = {}) {
  const timers = new FakeTimers();
  const engine = options.engine === undefined ? new FakeEngine() : options.engine;
  let auto = options.auto ?? true;
  const quits: Array<() => void> = [];
  const statuses: UpdateStatus[] = [];
  const updater = new Updater({
    isPackaged: options.packaged ?? true,
    isPortable: options.portable ?? false,
    autoUpdateEnabled: () => auto,
    loadEngine: async () => engine,
    quitWith: (finalize) => quits.push(finalize),
    timers,
    now: () => timers.now,
    logger: nullLogger
  });
  updater.onStatus((status) => statuses.push(status));
  return { updater, engine, timers, quits, statuses, setAuto: (value: boolean) => (auto = value) };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Updater', () => {
  it('is disabled in dev builds, even portable ones', async () => {
    for (const portable of [false, true]) {
      const dev = setup({ packaged: false, portable });
      assert.deepEqual(dev.updater.status, { state: 'disabled', reason: 'dev' });
      const check = await dev.updater.check();
      assert.equal(!check.ok && check.error.code, 'UPDATE_UNAVAILABLE');
      assert.equal(dev.engine?.checks, 0);
    }
  });

  it('checks 30 s after start and every 6 h when enabled', async () => {
    const { updater, engine, timers } = setup();
    updater.refreshSchedule();
    timers.advance(29_999);
    assert.equal(engine?.checks, 0);
    timers.advance(1);
    await flush();
    assert.equal(engine?.checks, 1);
    engine?.emit('update-not-available', { version: '2.0.0' });
    timers.advance(6 * 60 * 60_000);
    await flush();
    assert.equal(engine?.checks, 2);
    assert.equal(engine?.autoDownload, true);
    assert.equal(engine?.autoInstallOnAppQuit, false);
  });

  it('tracks download progress and installs through the quit sequence', async () => {
    const { updater, engine, quits, statuses } = setup();
    assert.equal(updater.install().ok, false);
    await updater.check();
    engine?.emit('update-available', { version: '2.1.0' });
    engine?.emit('download-progress', { percent: 42.4 });
    engine?.emit('update-downloaded', { version: '2.1.0' });
    assert.deepEqual(statuses.slice(-3), [
      { state: 'available', version: '2.1.0' },
      { state: 'downloading', version: '2.1.0', percent: 42 },
      { state: 'ready', version: '2.1.0' }
    ]);
    assert.equal(updater.install().ok, true);
    assert.equal(quits.length, 1);
    quits[0]?.();
    assert.deepEqual(engine?.installs, [[false, true]]);
  });

  it('respects the setting for automatic checks but still allows manual ones', async () => {
    const { updater, engine, timers, setAuto } = setup({ auto: false });
    updater.refreshSchedule();
    assert.deepEqual(updater.status, { state: 'disabled', reason: 'setting' });
    timers.advance(60_000);
    assert.equal(engine?.checks, 0);
    assert.equal((await updater.check()).ok, true);
    assert.equal(engine?.checks, 1);
    setAuto(true);
    engine?.emit('update-not-available', { version: '2.0.0' });
    updater.refreshSchedule();
    assert.equal(updater.status.state, 'idle');
  });

  it('reports errors and a missing electron-updater', async () => {
    const { updater, engine } = setup();
    await updater.check();
    engine?.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\nstack'));
    assert.deepEqual(updater.status, {
      state: 'error',
      error: { code: 'UPDATE_FAILED', params: { detail: 'net::ERR_INTERNET_DISCONNECTED' } }
    });

    const missing = setup({ engine: null });
    const result = await missing.updater.check();
    assert.equal(!result.ok && result.error.code, 'UPDATE_UNAVAILABLE');
    assert.deepEqual(missing.updater.status, { state: 'disabled', reason: 'unsupported' });
  });
});

describe('isPortableBuild', () => {
  it('recognizes the variables set by the portable launcher', () => {
    assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_FILE: 'C:\\Apps\\Yami.exe' }), true);
    assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: 'C:\\Apps' }), true);
    assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_FILE: '', PORTABLE_EXECUTABLE_DIR: undefined }), false);
    assert.equal(isPortableBuild({}), false);
  });
});

describe('Updater (portable build: check-only)', () => {
  const manual = (over: Partial<Extract<UpdateStatus, { state: 'manual' }>> = {}): UpdateStatus => ({
    state: 'manual',
    version: null,
    checkedAt: null,
    checking: false,
    error: null,
    ...over
  });

  it('reports a newer release without ever downloading or installing it', async () => {
    const { updater, engine, timers, quits, statuses } = setup({ portable: true });
    assert.deepEqual(updater.status, manual());
    timers.advance(5_000);
    assert.equal((await updater.check()).ok, true);
    assert.equal(engine?.autoDownload, false);
    assert.equal(engine?.autoInstallOnAppQuit, false);
    assert.deepEqual(statuses[0], manual({ checking: true }));
    engine?.emit('update-available', { version: '2.1.0' });
    assert.deepEqual(updater.status, manual({ version: '2.1.0', checkedAt: 5_000 }));

    // Even if electron-updater emitted download events, the portable build never offers an install.
    engine?.emit('download-progress', { percent: 50 });
    engine?.emit('update-downloaded', { version: '2.1.0' });
    assert.deepEqual(updater.status, manual({ version: '2.1.0', checkedAt: 5_000 }));
    assert.equal(updater.hasPendingInstall, false);
    const install = updater.install();
    assert.equal(!install.ok && install.error.code, 'UPDATE_UNAVAILABLE');
    assert.equal(updater.installOnQuit(), false);
    assert.equal(quits.length, 0);
    assert.deepEqual(engine?.installs, []);
  });

  it('clears the found version once the portable build is current', async () => {
    const { updater, engine, timers } = setup({ portable: true });
    await updater.check();
    engine?.emit('update-available', { version: '2.1.0' });
    timers.advance(1_000);
    await updater.check();
    engine?.emit('update-not-available', { version: '2.1.0' });
    assert.deepEqual(updater.status, manual({ checkedAt: 1_000 }));
  });

  it('checks automatically when enabled and keeps the manual status when the setting is off', async () => {
    const auto = setup({ portable: true });
    auto.updater.refreshSchedule();
    auto.timers.advance(30_000);
    await flush();
    assert.equal(auto.engine?.checks, 1);

    const off = setup({ portable: true, auto: false });
    off.updater.refreshSchedule();
    off.timers.advance(60_000);
    await flush();
    assert.equal(off.engine?.checks, 0);
    assert.equal(off.updater.status.state, 'manual');
    assert.equal((await off.updater.check()).ok, true);
    assert.equal(off.engine?.checks, 1);
  });

  it('reports check failures in the manual status and stops spinning without a result', async () => {
    const { updater, engine } = setup({ portable: true });
    await updater.check();
    assert.deepEqual(updater.status, manual(), 'no result event: checking is cleared');
    engine?.emit('error', new Error('HttpError: 404\nstack'));
    assert.deepEqual(
      updater.status,
      manual({ error: { code: 'UPDATE_FAILED', params: { detail: 'HttpError: 404' } } })
    );
    await updater.check();
    assert.deepEqual(updater.status, manual(), 'a new check clears the previous error');
  });

  it('keeps the manual status (with the reason) when electron-updater is missing', async () => {
    const { updater } = setup({ portable: true, engine: null });
    const result = await updater.check();
    assert.equal(!result.ok && result.error.code, 'UPDATE_UNAVAILABLE');
    assert.deepEqual(updater.status, manual({ error: { code: 'UPDATE_UNAVAILABLE' } }));
  });
});
