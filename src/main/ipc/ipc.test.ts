import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppView } from '../../shared/contracts/ipc.ts';
import { ok } from '../../shared/kernel/result.ts';
import { nullLogger } from '../infrastructure/logger.ts';
import { registerHostController, validateHostRequest } from './controllers/host-controller.ts';
import { registerTrayController } from './controllers/tray-controller.ts';
import { registerVaultController } from './controllers/vault-controller.ts';
import { IpcRouter, type IpcEventLike, type IpcMainLike } from './ipc-router.ts';

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown;

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>();
  readonly listeners = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener);
  }
  removeAllListeners(channel?: string): void {
    if (channel) this.listeners.delete(channel);
  }
  invoke(channel: string, event: IpcEventLike, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler(event, ...args);
  }
}

const trusted: IpcEventLike = { sender: { id: 1 }, senderFrame: { url: 'app://yami/index.html', parent: null } };
const untrusted: IpcEventLike = { sender: { id: 2 }, senderFrame: { url: 'file:///x.html', parent: null } };

function setup() {
  const ipc = new FakeIpcMain();
  const router = new IpcRouter(ipc, {
    resolveSender: (event): AppView | null => (event.sender.id === 1 ? 'main' : null),
    logger: nullLogger
  });
  return { ipc, router };
}

describe('IpcRouter', () => {
  it('rejects untrusted senders with IPC_UNAUTHORIZED and never calls the handler', async () => {
    const { ipc, router } = setup();
    let calls = 0;
    router.handleResult('x:do', () => {
      calls += 1;
      return { ok: true, data: 1 };
    });
    assert.deepEqual(await ipc.invoke('x:do', untrusted), { ok: false, error: { code: 'IPC_UNAUTHORIZED' } });
    assert.equal(calls, 0);
    assert.deepEqual(await ipc.invoke('x:do', trusted), { ok: true, data: 1 });
  });

  it('turns handler exceptions into INTERNAL results', async () => {
    const { ipc, router } = setup();
    router.handleResult('x:boom', () => {
      throw new Error('kaboom');
    });
    const result = (await ipc.invoke('x:boom', trusted)) as { ok: boolean; error: { code: string } };
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INTERNAL');
  });

  it('rejects value channels for untrusted senders and ignores their fire-and-forget calls', async () => {
    const { ipc, router } = setup();
    let fired = 0;
    router.handleValue('x:get', () => 42);
    router.on('x:send', () => {
      fired += 1;
    });
    await assert.rejects(async () => ipc.invoke('x:get', untrusted));
    assert.equal(await ipc.invoke('x:get', trusted), 42);
    ipc.listeners.get('x:send')?.(untrusted);
    ipc.listeners.get('x:send')?.(trusted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fired, 1);
  });

  it('refuses duplicate registrations and disposes channels', () => {
    const { ipc, router } = setup();
    router.handleValue('x:get', () => 1);
    assert.throws(() => router.handleValue('x:get', () => 2));
    router.dispose();
    assert.equal(ipc.handlers.size, 0);
  });
});

describe('host:request validation', () => {
  it('accepts renderer commands with valid payloads', () => {
    const result = validateHostRequest({
      command: 'downloads.start',
      payload: { urls: [' https://a.com/x '], engine: 'gallery-dl', scope: 'single' }
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.payload, { urls: ['https://a.com/x'], engine: 'gallery-dl', scope: 'single' });
  });

  it('refuses main-only commands, unknown commands and invalid payloads', () => {
    const cases: Array<[unknown, string]> = [
      [{ command: 'system.configure', payload: {} }, 'IPC_UNAUTHORIZED'],
      [{ command: 'accounts.pixiv.save', payload: {} }, 'IPC_UNAUTHORIZED'],
      [{ command: 'lifecycle.shutdown', payload: { mode: 'pause' } }, 'IPC_UNAUTHORIZED'],
      [{ command: 'nope', payload: {} }, 'VALIDATION_FAILED'],
      [
        {
          command: 'downloads.start',
          payload: { urls: ['javascript:alert(1)'], engine: 'gallery-dl', scope: 'single' }
        },
        'VALIDATION_FAILED'
      ],
      [{ command: 'folders.list', payload: { extra: 1 } }, 'VALIDATION_FAILED'],
      ['folders.list', 'VALIDATION_FAILED']
    ];
    for (const [arg, code] of cases) {
      const result = validateHostRequest(arg);
      assert.equal(!result.ok && result.error.code, code, JSON.stringify(arg));
    }
    const nested = validateHostRequest({
      command: 'downloads.start',
      payload: { urls: [], engine: 'gallery-dl', scope: 'single' }
    });
    assert.deepEqual(!nested.ok && nested.error.params, { path: 'payload.urls' });
  });

  it('forwards only validated requests to the host', async () => {
    const { ipc, router } = setup();
    const forwarded: Array<[string, unknown]> = [];
    registerHostController(router, {
      forward: async (command, payload) => {
        forwarded.push([command, payload]);
        return ok({ folders: [] });
      },
      status: () => ({ state: 'ready' }),
      restart: () => ok(null)
    });
    assert.deepEqual(await ipc.invoke('host:request', trusted, { command: 'folders.list', payload: {} }), {
      ok: true,
      data: { folders: [] }
    });
    const denied = (await ipc.invoke('host:request', trusted, { command: 'system.configure', payload: {} })) as {
      ok: boolean;
    };
    assert.equal(denied.ok, false);
    assert.deepEqual(forwarded, [['folders.list', {}]]);
    assert.deepEqual(await ipc.invoke('host:get-status', trusted), { state: 'ready' });
  });
});

describe('tray controller', () => {
  it('honors tray commands only from the tray panel', async () => {
    const ipc = new FakeIpcMain();
    const router = new IpcRouter(ipc, {
      resolveSender: (event): AppView | null =>
        event.sender.id === 1 ? 'main' : event.sender.id === 3 ? 'tray' : null,
      logger: nullLogger
    });
    const calls: string[] = [];
    registerTrayController(router, {
      hide: () => calls.push('hide'),
      setHeight: (height) => calls.push(`height:${height}`),
      dismissSuggestion: (url) => calls.push(`dismiss:${url}`)
    });
    const tray: IpcEventLike = {
      sender: { id: 3 },
      senderFrame: { url: 'app://yami/index.html?view=tray', parent: null }
    };
    const send = (channel: string, event: IpcEventLike, arg?: unknown): void => {
      ipc.listeners.get(channel)?.(event, arg);
    };
    for (const event of [trusted, untrusted]) {
      send('tray:hide', event);
      send('tray:set-height', event, { height: 300 });
      send('tray:dismiss-suggestion', event, { url: 'https://a.com/x' });
    }
    send('tray:dismiss-suggestion', tray, { url: 'javascript:alert(1)' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    send('tray:hide', tray);
    send('tray:set-height', tray, { height: 300 });
    send('tray:dismiss-suggestion', tray, { url: 'https://a.com/x' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['hide', 'height:300', 'dismiss:https://a.com/x']);
  });
});

describe('vault controller', () => {
  it('resets only for trusted senders, without arguments, for the calling view', async () => {
    const { ipc, router } = setup();
    const views: AppView[] = [];
    registerVaultController(router, {
      reset: async (view) => {
        views.push(view);
        return ok({ outcome: 'reset' as const });
      }
    });
    assert.deepEqual(await ipc.invoke('vault:reset', untrusted), { ok: false, error: { code: 'IPC_UNAUTHORIZED' } });
    assert.deepEqual(await ipc.invoke('vault:reset', trusted, { force: true }), {
      ok: false,
      error: { code: 'VALIDATION_FAILED', params: { path: 'payload' } }
    });
    assert.deepEqual(views, []);
    assert.deepEqual(await ipc.invoke('vault:reset', trusted), { ok: true, data: { outcome: 'reset' } });
    assert.deepEqual(views, ['main']);
  });
});
