/**
 * End-to-end download through the real host pipeline (coordinator, launcher, log
 * reader, gallery-dl parser, SQLite) using a fake `gallery-dl` executable installed
 * as a managed tool. POSIX only (the fake engine is a script with a shebang).
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { makePrivateTemp } from './support/private-temp.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
// YAMI_HOST_ENTRY lets CI run the same tests against the production bundle (dist-electron/host.cjs).
const ENTRY = process.env['YAMI_HOST_ENTRY'] ?? path.join(ROOT, 'src/host/bootstrap/index.ts');
const HARNESS = pathToFileURL(path.join(ROOT, 'tests/support/fake-parent-port.mjs')).href;
const skip = process.platform === 'win32' ? 'fake engine is a POSIX script' : false;

type Msg = {
  kind: string;
  id?: string;
  ok?: boolean;
  data?: unknown;
  error?: { code: string };
  event?: Record<string, unknown> & { type: string };
};

describe('download flow (end-to-end)', { skip }, () => {
  let root: string;
  let child: ReturnType<typeof fork>;
  const events: Array<Record<string, unknown> & { type: string }> = [];
  const pending = new Map<string, (m: Msg) => void>();
  let seq = 0;

  const request = (command: string, payload: unknown): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const id = `d${(seq += 1)}`;
      const timer = setTimeout(() => reject(new Error(`timeout ${command}`)), 30_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.send({ kind: 'request', id, command, payload });
    });

  const waitForEvent = (predicate: (e: Record<string, unknown> & { type: string }) => boolean, ms = 20_000) =>
    new Promise<Record<string, unknown> & { type: string }>((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const found = events.find(predicate);
        if (found) resolve(found);
        else if (Date.now() - started > ms) reject(new Error('event timeout'));
        else setTimeout(tick, 25);
      };
      tick();
    });

  before(async () => {
    root = makePrivateTemp('yami-flow-');
    const bin = path.join(root, 'runtime', 'bin');
    mkdirSync(bin, { recursive: true });
    copyFileSync(path.join(ROOT, 'tests/support/fake-gallery-dl.sh'), path.join(bin, 'gallery-dl'));
    chmodSync(path.join(bin, 'gallery-dl'), 0o755);
    const home = path.join(root, 'home');
    mkdirSync(home, { recursive: true });
    child = fork(ENTRY, [], {
      execArgv: ['--disable-warning=ExperimentalWarning', '--import', HARNESS],
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    await new Promise<void>((resolve) => {
      child.on('message', (raw: unknown) => {
        const m = raw as Msg;
        if (m.kind === 'ready') resolve();
        if (m.kind === 'response' && m.id) pending.get(m.id)?.(m);
        if (m.kind === 'event' && m.event) events.push(m.event);
      });
    });
    const configured = await request('system.configure', {
      paths: {
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'runtime'),
        logsDir: path.join(root, 'logs'),
        tempDir: path.join(root, 'tmp'),
        legacyDir: null,
        protectedDirs: []
      },
      vaultKey: randomBytes(32).toString('base64'),
      defaultDownloadDir: path.join(root, 'Downloads'),
      isPackaged: false,
      appVersion: '2.0.0-test'
    });
    assert.equal(configured.ok, true, JSON.stringify(configured.error));
  });

  after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  it('detects the managed engine', async () => {
    const init = await request('session.init', {});
    const engines = (init.data as { state: { engines: Record<string, { available: boolean; version: string }> } }).state
      .engines;
    assert.equal(engines['gallery-dl']?.available, true);
    assert.equal(engines['gallery-dl']?.version, '1.30.9');
  });

  it('downloads, records files and reports an ok outcome', async () => {
    const started = await request('downloads.start', {
      urls: ['https://example.com/album/1'],
      engine: 'gallery-dl',
      scope: 'single'
    });
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const [conversationId] = (started.data as { conversationIds: string[] }).conversationIds;
    const finished = await waitForEvent((e) => e.type === 'download.finished');
    const download = finished['download'] as {
      conversationId: string;
      status: string;
      outcome: { kind: string };
      counters: { done: number; skipped: number };
    };
    assert.equal(download.conversationId, conversationId);
    assert.equal(download.status, 'completed');
    assert.equal(download.outcome.kind, 'ok');
    assert.deepEqual([download.counters.done, download.counters.skipped], [2, 1]);

    const files = await request('conversations.files', { conversationId, limit: 50 });
    const names = (files.data as { items: Array<{ name: string; path: string }> }).items.map((f) => f.name).sort();
    assert.deepEqual(names, ['1.jpg', '2.png']);
    const first = (files.data as { items: Array<{ path: string }> }).items[0]?.path ?? '';
    assert.ok(first.includes(path.join('Downloads', 'gallery-dl', 'example', 'album ação')), first);
    assert.ok(existsSync(first));
  });

  it('marks an engine error without files as failed', async () => {
    await request('downloads.start', { urls: ['https://example.com/fail'], engine: 'gallery-dl', scope: 'single' });
    const failed = await waitForEvent(
      (e) => e.type === 'download.finished' && (e['download'] as { status: string }).status === 'failed'
    );
    const outcome = (failed['download'] as { outcome: { kind: string; reason: string } }).outcome;
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.reason, 'not-found');
  });

  it('pauses, resumes and stops a live engine process', async () => {
    const started = await request('downloads.start', {
      urls: ['https://example.com/slow/1'],
      engine: 'gallery-dl',
      scope: 'single'
    });
    const [id] = (started.data as { conversationIds: string[] }).conversationIds;
    const status = async (): Promise<string> =>
      ((await request('conversations.get', { conversationId: id })).data as { conversation: { status: string } })
        .conversation.status;
    await waitForEvent(
      (e) =>
        e.type === 'files.added' &&
        (e['items'] as Array<{ conversationId: string }>).some((f) => f.conversationId === id)
    );
    assert.equal(await status(), 'running');

    const paused = await request('downloads.pause', { conversationId: id });
    assert.equal(paused.ok, true, JSON.stringify(paused.error));
    assert.equal(await status(), 'paused');

    const resumed = await request('downloads.resume', { conversationId: id });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
    const deadline = Date.now() + 10_000;
    while ((await status()) !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(await status(), 'running');

    const stopped = await request('downloads.stop', { conversationId: id });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    assert.equal(await status(), 'cancelled');
    const again = await request('downloads.stop', { conversationId: id });
    assert.equal(again.error?.code, 'DOWNLOAD_NOT_ACTIVE');
  });

  it('shuts down', async () => {
    assert.equal((await request('lifecycle.shutdown', { mode: 'pause' })).ok, true);
  });
});
