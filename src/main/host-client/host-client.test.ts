import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawRequestEnvelope } from '../../shared/contracts/host-protocol.ts';
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';
import { ok } from '../../shared/kernel/result.ts';
import { FakeTimers } from '../infrastructure/fake-timers.ts';
import { nullLogger } from '../infrastructure/logger.ts';
import { HostClient, type ConfigurePayload } from './host-client.ts';
import type { HostProcess } from './host-process.ts';
import { RestartPolicy } from './restart-policy.ts';

class FakeHost implements HostProcess {
  readonly pid = 42;
  readonly sent: RawRequestEnvelope[] = [];
  killed = false;
  #onMessage: (message: unknown) => void = () => undefined;
  #onExit: (code: number) => void = () => undefined;

  postMessage(message: RawRequestEnvelope): void {
    this.sent.push(message);
  }
  kill(): void {
    this.killed = true;
  }
  onMessage(listener: (message: unknown) => void): void {
    this.#onMessage = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.#onExit = listener;
  }
  emit(message: unknown): void {
    this.#onMessage(message);
  }
  exit(code: number): void {
    this.#onExit(code);
  }
  reply(index: number, data: unknown): void {
    const request = this.sent[index];
    assert.ok(request, `no request #${index}`);
    this.emit({ kind: 'response', id: request.id, ok: true, data });
  }
}

const CONFIG: ConfigurePayload = {
  paths: { dataDir: '/d', runtimeDir: '/r', logsDir: '/l', tempDir: '/t', legacyDir: null, protectedDirs: [] },
  vaultKey: Buffer.alloc(32, 1).toString('base64'),
  defaultDownloadDir: '/dl',
  isPackaged: false,
  appVersion: '2.0.0'
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(configure: () => ConfigurePayload = () => CONFIG) {
  const timers = new FakeTimers();
  const hosts: FakeHost[] = [];
  const statuses: HostConnectionStatus[] = [];
  const client = new HostClient({
    spawn: () => {
      const host = new FakeHost();
      hosts.push(host);
      return host;
    },
    configure: async () => ok(configure()),
    timers,
    now: () => timers.now,
    logger: nullLogger
  });
  client.onStatus((status) => statuses.push(status));
  const bringUp = async (host: FakeHost): Promise<void> => {
    host.emit({ kind: 'ready', pid: 1 });
    await flush();
    const configure = host.sent.at(-1);
    assert.equal(configure?.command, 'system.configure');
    host.emit({ kind: 'response', id: configure.id, ok: true, data: { state: {} } });
    await flush();
  };
  return { timers, hosts, statuses, client, bringUp };
}

describe('HostClient', () => {
  it('sends system.configure first and becomes ready', async () => {
    const { client, hosts, statuses, bringUp } = setup();
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));
    client.start();
    assert.equal(hosts.length, 1);
    await bringUp(hosts[0] as FakeHost);
    assert.equal(client.isReady, true);
    assert.deepEqual(
      statuses.map((s) => s.state),
      ['starting', 'ready']
    );
    assert.deepEqual(events, ['state']);
    assert.equal(hosts[0]?.sent[0]?.command, 'system.configure');
  });

  it('correlates responses by id and resolves typed results', async () => {
    const { client, hosts, bringUp } = setup();
    client.start();
    const host = hosts[0] as FakeHost;
    await bringUp(host);
    const pending = client.request('folders.list', {});
    host.reply(1, { folders: [] });
    assert.deepEqual(await pending, { ok: true, value: { folders: [] } });
  });

  it('times out requests with HOST_TIMEOUT using COMMAND_SPECS', async () => {
    const { client, hosts, timers, bringUp } = setup();
    client.start();
    await bringUp(hosts[0] as FakeHost);
    const pending = client.request('folders.list', {});
    timers.advance(15_000);
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'HOST_TIMEOUT');
  });

  it('queues requests made while starting until the host is ready', async () => {
    const { client, hosts, bringUp } = setup();
    client.start();
    const host = hosts[0] as FakeHost;
    const pending = client.request('folders.list', {});
    await bringUp(host);
    await flush();
    assert.equal(host.sent[1]?.command, 'folders.list');
    host.reply(1, { folders: [] });
    assert.equal((await pending).ok, true);
  });

  it('rejects pending requests and restarts with backoff after a crash', async () => {
    const { client, hosts, timers, statuses, bringUp } = setup();
    client.start();
    await bringUp(hosts[0] as FakeHost);
    const pending = client.request('folders.list', {});
    (hosts[0] as FakeHost).exit(1);
    const result = await pending;
    assert.equal(!result.ok && result.error.code, 'HOST_UNAVAILABLE');
    assert.deepEqual(statuses.at(-1), {
      state: 'restarting',
      attempt: 1,
      error: { code: 'HOST_UNAVAILABLE', params: { exitCode: 1 } }
    });
    timers.advance(999);
    assert.equal(hosts.length, 1);
    timers.advance(1);
    assert.equal(hosts.length, 2);
    await bringUp(hosts[1] as FakeHost);
    assert.equal(client.isReady, true);
    assert.equal(hosts[1]?.sent[0]?.command, 'system.configure');
  });

  it('goes offline after 5 restarts within 60 s and recovers with restart()', async () => {
    const { client, hosts, timers, statuses } = setup();
    client.start();
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (const delay of delays) {
      (hosts.at(-1) as FakeHost).exit(1);
      timers.advance(delay);
    }
    assert.equal(hosts.length, 6);
    (hosts.at(-1) as FakeHost).exit(1);
    assert.equal(statuses.at(-1)?.state, 'offline');
    const denied = await client.request('folders.list', {});
    assert.equal(!denied.ok && denied.error.code, 'HOST_UNAVAILABLE');
    assert.equal(client.restart().ok, true);
    assert.equal(hosts.length, 7);
    assert.equal(statuses.at(-1)?.state, 'starting');
  });

  it('treats a missing ready message as a crash', () => {
    const { client, hosts, timers, statuses } = setup();
    client.start();
    timers.advance(20_000);
    assert.equal(hosts[0]?.killed, true);
    assert.equal(statuses.at(-1)?.state, 'restarting');
  });

  it('shutdown asks the host to pause, then kills it without restarting', async () => {
    const { client, hosts, timers, bringUp } = setup();
    client.start();
    const host = hosts[0] as FakeHost;
    await bringUp(host);
    const done = client.shutdown();
    assert.equal(host.sent[1]?.command, 'lifecycle.shutdown');
    assert.deepEqual(host.sent[1]?.payload, { mode: 'pause' });
    host.reply(1, {});
    await done;
    assert.equal(host.killed, true);
    host.exit(0);
    timers.advance(60_000);
    assert.equal(hosts.length, 1);
    const after = await client.request('folders.list', {});
    assert.equal(!after.ok && after.error.code, 'HOST_SHUTTING_DOWN');
  });

  it('gives the host up to 20 s to stop engines, then kills it anyway', async () => {
    const slow = setup();
    slow.client.start();
    const host = slow.hosts[0] as FakeHost;
    await slow.bringUp(host);
    let settled = false;
    const done = slow.client.shutdown().then(() => {
      settled = true;
    });
    // The host needs up to ~15 s (engines stopped in parallel, ~12 s internal deadline).
    slow.timers.advance(15_000);
    await flush();
    assert.equal(settled, false);
    assert.equal(host.killed, false);
    host.reply(1, {});
    await done;
    assert.equal(host.killed, true);

    const hung = setup();
    hung.client.start();
    const stuck = hung.hosts[0] as FakeHost;
    await hung.bringUp(stuck);
    let finished = false;
    const waiting = hung.client.shutdown().then(() => {
      finished = true;
    });
    hung.timers.advance(19_999);
    await flush();
    assert.equal(finished, false);
    hung.timers.advance(1);
    await waiting;
    assert.equal(stuck.killed, true);
    stuck.exit(1);
    hung.timers.advance(60_000);
    assert.equal(hung.hosts.length, 1);
  });

  it('finishes the shutdown at once when the host crashes meanwhile', async () => {
    const { client, hosts, timers, bringUp } = setup();
    client.start();
    const host = hosts[0] as FakeHost;
    await bringUp(host);
    const done = client.shutdown();
    host.exit(1);
    await done;
    timers.advance(60_000);
    assert.equal(hosts.length, 1);
  });

  it('configures the host with a disabled vault when the key is unavailable, and becomes ready', async () => {
    const degraded: ConfigurePayload = { ...CONFIG, vaultKey: null, vaultUnavailable: 'keystore' };
    const { client, hosts, statuses, bringUp } = setup(() => degraded);
    client.start();
    const host = hosts[0] as FakeHost;
    await bringUp(host);
    assert.deepEqual(host.sent[0]?.payload, degraded);
    assert.equal(client.isReady, true);
    assert.deepEqual(
      statuses.map((s) => s.state),
      ['starting', 'ready']
    );
  });

  it('restartWith pauses the host, runs the task once it exited, then starts a reconfigured one', async () => {
    let keyLoaded = false;
    const { client, hosts, statuses, bringUp } = setup(() =>
      keyLoaded ? CONFIG : { ...CONFIG, vaultKey: null, vaultUnavailable: 'corrupted' }
    );
    client.start();
    const first = hosts[0] as FakeHost;
    await bringUp(first);
    const seen: string[] = [];
    const restarted = client.restartWith(async () => {
      seen.push(`task: killed=${first.killed} hosts=${hosts.length}`);
      keyLoaded = true;
    });
    assert.equal(first.sent[1]?.command, 'lifecycle.shutdown');
    assert.deepEqual(first.sent[1]?.payload, { mode: 'pause' });
    // Requests made meanwhile wait for the next host instead of reaching the stopping one.
    const pending = client.request('folders.list', {});
    assert.equal(first.sent.length, 2);
    first.reply(1, {});
    await flush();
    // Killed, but the task waits until the process is really gone.
    assert.equal(first.killed, true);
    assert.deepEqual(seen, []);
    first.exit(0);
    await flush();
    assert.deepEqual(seen, ['task: killed=true hosts=1']);
    assert.equal(hosts.length, 2);
    const second = hosts[1] as FakeHost;
    await bringUp(second);
    assert.deepEqual(await restarted, { ok: true, value: null });
    assert.equal(second.sent[0]?.payload && (second.sent[0].payload as ConfigurePayload).vaultKey, CONFIG.vaultKey);
    await flush();
    assert.equal(second.sent[1]?.command, 'folders.list');
    second.reply(1, { folders: [] });
    assert.equal((await pending).ok, true);
    // The expected exit of the stopped host is not counted as a crash.
    assert.deepEqual(
      statuses.map((s) => s.state),
      ['starting', 'ready', 'starting', 'ready']
    );
  });

  it('restartWith also brings an offline host back and refuses to overlap', async () => {
    const { client, hosts, timers } = setup();
    client.start();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      (hosts.at(-1) as FakeHost).exit(1);
      timers.advance(delay);
    }
    (hosts.at(-1) as FakeHost).exit(1);
    assert.equal(client.status.state, 'offline');
    const count = hosts.length;
    let release: () => void = () => undefined;
    const restarted = client.restartWith(() => new Promise<void>((resolve) => (release = resolve)));
    const overlapping = await client.restartWith(async () => undefined);
    assert.equal(!overlapping.ok && overlapping.error.code, 'HOST_RESTARTING');
    // A manual reconnect meanwhile is absorbed: the running restartWith starts the host.
    assert.equal(client.restart().ok, true);
    assert.equal(hosts.length, count);
    release();
    await flush();
    assert.equal(hosts.length, count + 1);
    const host = hosts.at(-1) as FakeHost;
    host.emit({ kind: 'ready', pid: 1 });
    await flush();
    host.reply(0, { state: {} });
    assert.deepEqual(await restarted, { ok: true, value: null });
  });

  it('restartWith does not count a host that exits before replying to the stop as a crash', async () => {
    const { client, hosts, statuses, bringUp } = setup();
    client.start();
    await bringUp(hosts[0] as FakeHost);
    const restarted = client.restartWith(async () => undefined);
    (hosts[0] as FakeHost).exit(0);
    await flush();
    // Started right away: no crash backoff.
    assert.equal(hosts.length, 2);
    await bringUp(hosts[1] as FakeHost);
    assert.deepEqual(await restarted, { ok: true, value: null });
    assert.ok(!statuses.some((status) => status.state === 'restarting'));
  });

  it('restartWith skips the task when the old process does not exit in time, and still starts a host', async () => {
    const { client, hosts, timers, bringUp } = setup();
    client.start();
    await bringUp(hosts[0] as FakeHost);
    let ran = false;
    const restarted = client.restartWith(async () => {
      ran = true;
    });
    (hosts[0] as FakeHost).reply(1, {});
    await flush();
    timers.advance(4_999);
    await flush();
    assert.equal(hosts.length, 1);
    timers.advance(1);
    await flush();
    assert.equal(ran, false);
    assert.equal(hosts.length, 2);
    await bringUp(hosts[1] as FakeHost);
    assert.deepEqual(await restarted, { ok: false, error: { code: 'HOST_TIMEOUT', params: { command: 'exit' } } });
    assert.equal(client.isReady, true);
  });

  it('a quit while the restart stops the host waits for that pause and starts nothing', async () => {
    const { client, hosts, bringUp } = setup();
    client.start();
    const host = hosts[0] as FakeHost;
    await bringUp(host);
    let ran = false;
    const restarted = client.restartWith(async () => {
      ran = true;
    });
    let quitDone = false;
    const quit = client.shutdown().then(() => {
      quitDone = true;
    });
    await flush();
    // The restart's own stop request is the pause: no second request, nothing killed yet.
    assert.deepEqual(
      host.sent.map((request) => [request.command, request.payload]),
      [
        ['system.configure', CONFIG],
        ['lifecycle.shutdown', { mode: 'pause' }]
      ]
    );
    assert.equal(host.killed, false);
    assert.equal(quitDone, false);
    host.reply(1, {});
    await quit;
    assert.equal(host.killed, true);
    const result = await restarted;
    assert.equal(!result.ok && result.error.code, 'HOST_SHUTTING_DOWN');
    assert.equal(ran, false);
    assert.equal(hosts.length, 1);
  });

  it('a quit while the restarted host comes up lets it get ready, then pauses it', async () => {
    const { client, hosts, bringUp } = setup();
    client.start();
    const first = hosts[0] as FakeHost;
    await bringUp(first);
    const restarted = client.restartWith(async () => undefined);
    first.reply(1, {});
    await flush();
    first.exit(0);
    await flush();
    assert.equal(hosts.length, 2);
    const second = hosts[1] as FakeHost;
    const quit = client.shutdown();
    await bringUp(second);
    assert.deepEqual(await restarted, { ok: true, value: null });
    assert.equal(second.sent[1]?.command, 'lifecycle.shutdown');
    assert.deepEqual(second.sent[1]?.payload, { mode: 'pause' });
    second.reply(1, {});
    await quit;
    assert.equal(second.killed, true);
  });

  it('restartWith gives up when the app quits meanwhile', async () => {
    const { client, hosts, bringUp } = setup();
    client.start();
    await bringUp(hosts[0] as FakeHost);
    const restarted = client.restartWith(async () => undefined);
    client.dispose();
    const result = await restarted;
    assert.equal(!result.ok && result.error.code, 'HOST_SHUTTING_DOWN');
    assert.equal(hosts.length, 1);
  });

  it('ignores messages from a previous process generation', async () => {
    const { client, hosts, timers, bringUp } = setup();
    client.start();
    const first = hosts[0] as FakeHost;
    first.exit(1);
    timers.advance(1_000);
    const second = hosts[1] as FakeHost;
    first.emit({ kind: 'ready', pid: 1 });
    await flush();
    assert.equal(first.sent.length, 0);
    await bringUp(second);
    assert.equal(client.isReady, true);
  });
});

describe('RestartPolicy', () => {
  it('uses a sliding 60 s window', () => {
    let now = 0;
    const policy = new RestartPolicy({ now: () => now });
    for (let i = 0; i < 5; i += 1) assert.equal(policy.recordCrash().action, 'restart');
    assert.equal(policy.recordCrash().action, 'give-up');
    now = 61_000;
    assert.deepEqual(policy.recordCrash(), { action: 'restart', attempt: 1, delayMs: 1_000 });
  });
});
