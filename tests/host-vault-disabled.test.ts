/**
 * End-to-end: the host configured without a vault key (main could not load it) still
 * starts and serves downloads/history/library, refuses secret operations with
 * VAULT_UNAVAILABLE, leaves the vault and the legacy secrets untouched and defers the
 * legacy import until a start with a working vault.
 */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { HostCommand } from '../src/shared/contracts/host-protocol.ts';
import { buildLegacyDir } from '../src/host/infrastructure/legacy/test-fixtures.ts';
import { makePrivateTemp } from './support/private-temp.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = process.env['YAMI_HOST_ENTRY'] ?? path.join(ROOT, 'src/host/bootstrap/index.ts');
const HARNESS = pathToFileURL(path.join(ROOT, 'tests/support/fake-parent-port.mjs')).href;

interface Response {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; params?: Record<string, unknown> };
}

interface StateShape {
  readonly config: { readonly vault: unknown; readonly accounts: { readonly pixiv: { readonly connected: boolean } } };
}

/** Minimal driver of the real host entry point (same protocol as main). */
class Host {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, (response: Response) => void>();
  #nextId = 0;
  readonly ready: Promise<void>;

  constructor(home: string) {
    this.#child = fork(ENTRY, [], {
      execArgv: ['--disable-warning=ExperimentalWarning', '--import', HARNESS],
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    this.ready = new Promise((resolve, reject) => {
      this.#child.once('error', reject);
      this.#child.on('message', (message: unknown) => {
        const msg = message as { kind: string; id?: string } & Response;
        if (msg.kind === 'ready') resolve();
        else if (msg.kind === 'response' && msg.id) this.#pending.get(msg.id)?.(msg);
      });
    });
  }

  request(command: HostCommand, payload: unknown): Promise<Response> {
    const id = `t${(this.#nextId += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${command}`)), 30_000);
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(response);
      });
      this.#child.send({ kind: 'request', id, command, payload });
    });
  }

  async stop(): Promise<void> {
    if (this.#child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.#child.once('exit', resolve));
    await this.request('lifecycle.shutdown', { mode: 'pause' });
    await exited;
  }

  kill(): void {
    if (this.#child.exitCode === null) this.#child.kill('SIGKILL');
  }
}

describe('host with a disabled vault (end-to-end)', () => {
  let root: string;
  let legacyDir: string;
  let dataDir: string;
  let host: Host;
  const hosts: Host[] = [];
  const sealed = Buffer.from('sealed with the lost key');

  const configure = (target: Host, vault: Record<string, unknown>): Promise<Response> =>
    target.request('system.configure', {
      paths: {
        dataDir,
        runtimeDir: path.join(root, 'runtime'),
        logsDir: path.join(root, 'logs'),
        tempDir: path.join(root, 'tmp'),
        legacyDir,
        protectedDirs: [path.join(root, 'app')]
      },
      ...vault,
      defaultDownloadDir: path.join(root, 'Downloads', 'Yami'),
      isPackaged: false,
      appVersion: '2.0.0-test'
    });

  const start = async (): Promise<Host> => {
    const started = new Host(path.join(root, 'home'));
    hosts.push(started);
    await started.ready;
    return started;
  };

  before(async () => {
    root = makePrivateTemp('yami-vault-off-');
    mkdirSync(path.join(root, 'home'), { recursive: true });
    legacyDir = buildLegacyDir(root);
    dataDir = path.join(root, 'userData', 'data');
    mkdirSync(path.join(dataDir, 'vault', 'cookies'), { recursive: true });
    writeFileSync(path.join(dataDir, 'vault', 'cookies', 'site.txt.enc'), sealed);
    host = await start();
  });

  after(() => {
    for (const started of hosts) started.kill();
    rmSync(root, { recursive: true, force: true });
  });

  it('starts without a key and reports the disabled vault in the state', async () => {
    const res = await configure(host, { vaultKey: null, vaultUnavailable: 'keystore' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const state = (res.data as { state: StateShape }).state;
    assert.deepEqual(state.config.vault, { state: 'disabled', reason: 'keystore' });
    assert.equal(state.config.accounts.pixiv.connected, false);
  });

  it('keeps history and library features working', async () => {
    assert.equal((await host.request('session.init', {})).ok, true);
    const created = await host.request('folders.create', { name: 'Artes', color: '#60A5FA' });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    // The legacy import is deferred (its secrets cannot be migrated yet).
    assert.deepEqual((await host.request('conversations.list', { limit: 10 })).data, { items: [], nextCursor: null });
  });

  it('lists no cookies and refuses cookie and Pixiv writes with VAULT_UNAVAILABLE', async () => {
    const list = await host.request('cookies.list', {});
    assert.deepEqual(list.data, { files: [], active: null, bindings: [], fromBrowser: false });
    const content = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t2147483647\tsid\tv\n';
    assert.equal((await host.request('cookies.upload', { name: 'new.txt', content })).error?.code, 'VAULT_UNAVAILABLE');
    assert.equal((await host.request('cookies.delete', { name: 'site.txt' })).error?.code, 'VAULT_UNAVAILABLE');
    assert.equal((await host.request('cookies.setBindings', { bindings: [] })).error?.code, 'VAULT_UNAVAILABLE');
    assert.equal((await host.request('cookies.select', { name: null })).error?.code, 'VAULT_UNAVAILABLE');
    const pixiv = await host.request('accounts.pixiv.save', {
      refreshToken: 'x'.repeat(20),
      userName: 'ana',
      userId: '1'
    });
    assert.equal(pixiv.error?.code, 'VAULT_UNAVAILABLE');
    const browser = await host.request('cookies.setFromBrowser', { enabled: true });
    assert.equal(browser.ok, true, JSON.stringify(browser.error));
  });

  it('touches neither the vault nor the legacy secrets', async () => {
    await host.stop();
    assert.deepEqual(readFileSync(path.join(dataDir, 'vault', 'cookies', 'site.txt.enc')), sealed);
    assert.ok(existsSync(path.join(legacyDir, 'cookies', 'x.com.txt')));
    assert.ok(existsSync(path.join(legacyDir, 'credentials.json')));
  });

  it('runs the deferred legacy import once a working vault is configured', async () => {
    const next = await start();
    const res = await configure(next, { vaultKey: randomBytes(32).toString('base64') });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.deepEqual((res.data as { state: StateShape }).state.config.vault, { state: 'ready' });
    const list = (await next.request('conversations.list', { limit: 50 })).data as { items: unknown[] };
    assert.ok(list.items.length > 0);
    await next.stop();
  });
});
