/**
 * End-to-end test of the download host process: spawns the real entry point
 * (`src/host/bootstrap/index.ts`) with a fake parent port and drives it through
 * the protocol exactly like the main process does.
 */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { HostCommand, CommandPayload } from '../src/shared/contracts/host-protocol.ts';
import { makePrivateTemp } from './support/private-temp.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
// YAMI_HOST_ENTRY lets CI run the same tests against the production bundle (dist-electron/host.cjs).
const ENTRY = process.env['YAMI_HOST_ENTRY'] ?? path.join(ROOT, 'src/host/bootstrap/index.ts');
const HARNESS = pathToFileURL(path.join(ROOT, 'tests/support/fake-parent-port.mjs')).href;

interface Response {
  readonly kind: 'response';
  readonly id: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; params?: Record<string, unknown> };
}

class HostHarness {
  readonly child: ChildProcess;
  readonly events: Array<{ type: string } & Record<string, unknown>> = [];
  readonly #pending = new Map<string, (response: Response) => void>();
  #nextId = 0;
  readonly ready: Promise<void>;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = fork(ENTRY, [], {
      execArgv: ['--disable-warning=ExperimentalWarning', '--import', HARNESS],
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.on('message', (message: unknown) => {
        const msg = message as { kind: string; id?: string; event?: { type: string } };
        if (msg.kind === 'ready') resolve();
        else if (msg.kind === 'response' && msg.id) this.#pending.get(msg.id)?.(msg as Response);
        else if (msg.kind === 'event' && msg.event) this.events.push(msg.event);
      });
    });
  }

  request<C extends HostCommand>(command: C, payload: CommandPayload<C> | Record<string, unknown>): Promise<Response> {
    const id = `t${(this.#nextId += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${command}`)), 30_000);
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(response);
      });
      this.child.send({ kind: 'request', id, command, payload });
    });
  }

  exited(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve(this.child.exitCode);
      else this.child.once('exit', (code) => resolve(code));
    });
  }
}

describe('host process (end-to-end)', () => {
  let root: string;
  let host: HostHarness;
  let downloadDir: string;

  before(async () => {
    root = makePrivateTemp('yami-host-it-');
    downloadDir = path.join(root, 'Downloads', 'Yami');
    const home = path.join(root, 'home');
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(root, 'empty-path'), { recursive: true });
    // Hermetic: the host probes the system PATH, so a developer's own gallery-dl/yt-dlp must not be found.
    const toolOverride = /^YAMI_(GALLERY_DL|YT_DLP|DENO_BIN|FFMPEG|PYTHON_BIN)$/;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH' && !toolOverride.test(key))
    );
    host = new HostHarness({
      ...env,
      PATH: path.join(root, 'empty-path'),
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'test'
    });
    await host.ready;
  });

  after(async () => {
    if (host.child.exitCode === null) host.child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses commands before configuration', async () => {
    const res = await host.request('session.init', {});
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'HOST_UNAVAILABLE');
  });

  it('rejects malformed payloads with VALIDATION_FAILED', async () => {
    const res = await host.request('system.configure', { paths: {} });
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'VALIDATION_FAILED');
  });

  it('configures and returns the initial state', async () => {
    const res = await host.request('system.configure', {
      paths: {
        dataDir: path.join(root, 'userData', 'data'),
        runtimeDir: path.join(root, 'runtime'),
        logsDir: path.join(root, 'logs'),
        tempDir: path.join(root, 'tmp'),
        legacyDir: null,
        protectedDirs: [path.join(root, 'app')]
      },
      vaultKey: randomBytes(32).toString('base64'),
      defaultDownloadDir: downloadDir,
      isPackaged: false,
      appVersion: '2.0.0-test'
    });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const state = (res.data as { state: { config: { downloadDir: string }; status: string } }).state;
    assert.equal(state.status, 'idle');
    assert.ok(state.config.downloadDir.endsWith(path.join('Downloads', 'Yami')));
    // Prefer the host's canonical path (Windows short/long names can diverge from the lexical dir).
    downloadDir = state.config.downloadDir;
  });

  it('refuses a second configuration', async () => {
    const res = await host.request('system.configure', {});
    assert.equal(res.ok, false);
  });

  it('serves session, folders and conversations', async () => {
    assert.equal((await host.request('session.init', {})).ok, true);
    const created = await host.request('folders.create', { name: '  Artes  ', color: '#60A5FA' });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const folders = await host.request('folders.list', {});
    assert.equal((folders.data as { folders: Array<{ name: string }> }).folders[0]?.name, 'Artes');
    const list = await host.request('conversations.list', { limit: 10 });
    assert.deepEqual(list.data, { items: [], nextCursor: null });
  });

  it('refuses downloads when the engine is not installed', async () => {
    const res = await host.request('downloads.start', {
      urls: ['https://example.com/gallery/1'],
      engine: 'gallery-dl',
      scope: 'single'
    });
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'ENGINE_UNAVAILABLE');
  });

  it('stores cookies encrypted and validates their format', async () => {
    const bad = await host.request('cookies.upload', { name: 'x.txt', content: 'not a cookie file' });
    assert.equal(bad.error?.code, 'COOKIES_INVALID_FORMAT');
    const content = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t2147483647\tsid\tsecret-value\n';
    const good = await host.request('cookies.upload', { name: 'example.txt', content });
    assert.equal(good.ok, true, JSON.stringify(good.error));
    const snapshot = good.data as { files: Array<{ name: string; domains: string[] }> };
    assert.deepEqual(
      snapshot.files.map((f) => [f.name, f.domains]),
      [['example.txt', ['example.com']]]
    );
  });

  it('keeps file operations inside the download folder', async () => {
    const outside = await host.request('files.inspect', { path: path.join(root, 'home') });
    assert.equal(outside.ok, false);
    assert.equal(outside.error?.code, 'PATH_OUTSIDE_SANDBOX');
    const file = path.join(downloadDir, 'gallery-dl', 'site', 'a.jpg');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
    const inside = await host.request('files.inspect', { path: file });
    assert.equal(inside.ok, true, JSON.stringify(inside.error));
    assert.equal((inside.data as { risk: string; mediaType: string }).risk, 'safe');
  });

  it('shuts down cleanly on request', async () => {
    const res = await host.request('lifecycle.shutdown', { mode: 'pause' });
    assert.equal(res.ok, true);
    assert.equal(await host.exited(), 0);
  });
});
