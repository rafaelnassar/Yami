import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import type { ToolId } from '../../../shared/domain/engine.ts';
import type { RuntimeProgressDto } from '../../../shared/contracts/dto.ts';
import type { HostSettings } from '../ports/persistence.ts';
import { parseManifest, resolvePlatform } from './manifest.ts';
import { RuntimeToolsService } from './runtime-service.ts';
import {
  FakeDownloader,
  FakeEvents,
  FakeExtractor,
  FakeInstaller,
  FakeLogger,
  FakePip,
  FakeProbe,
  FakeReleases,
  FakeSettings,
  ManualClock,
  probed,
  waitFor
} from './testing-fakes.ts';

const SHA: Record<ToolId, string> = {
  'gallery-dl': '1'.repeat(64),
  'yt-dlp': '2'.repeat(64),
  deno: '3'.repeat(64),
  ffmpeg: '4'.repeat(64),
  python: '5'.repeat(64)
};
const URL: Record<ToolId, string> = {
  'gallery-dl': 'https://gh.test/gdl/2026.08.19/gallery-dl_linux',
  'yt-dlp': 'https://gh.test/yt/2025.11.12/yt-dlp_linux',
  deno: 'https://gh.test/deno/v2.5.6/deno-x86_64-unknown-linux-gnu.zip',
  ffmpeg: 'https://gh.test/ffmpeg/b6.0/linux-x64',
  python: 'https://gh.test/pbs/cpython-3.12.14.tar.gz'
};

const GDL_LOCK = [
  { name: 'gallery-dl', version: '1.32.9', sha256: ['a'.repeat(64)] },
  { name: 'requests', version: '2.32.5', sha256: ['b'.repeat(64)] }
];
const YTDLP_LOCK = [
  { name: 'yt-dlp', version: '2025.11.12', sha256: ['c'.repeat(64)] },
  { name: 'requests', version: '2.32.5', sha256: ['b'.repeat(64)] },
  { name: 'brotli', version: '1.1.0', sha256: ['d'.repeat(64)] }
];

type LockState = 'locked' | 'none' | 'unsupported';

function manifestFor(unpinned: ToolId | null, locks: LockState = 'locked') {
  const entries: Record<LockState, (lock: unknown) => object> = {
    locked: (lock) => ({ lock: { 'linux-x64': lock } }),
    none: () => ({}),
    unsupported: () => ({ lock: { 'linux-x64': { unsupported: 'no wheel for brotli' } } })
  };
  const lockOf = entries[locks];
  const asset = (tool: ToolId, version: string, archive: string, entry?: string) => ({
    'linux-x64': {
      version,
      url: URL[tool],
      sha256: tool === unpinned ? null : SHA[tool],
      archive,
      ...(entry ? { entry } : {})
    }
  });
  const parsed = parseManifest({
    schemaVersion: 1,
    tools: {
      'gallery-dl': { assets: asset('gallery-dl', '2026.08.19', 'none') },
      'yt-dlp': {
        latest: { repo: 'yt-dlp/yt-dlp', checksumsAsset: 'SHA2-256SUMS' },
        assets: asset('yt-dlp', '2025.11.12', 'none')
      },
      deno: { assets: asset('deno', '2.5.6', 'zip', 'deno') },
      ffmpeg: { assets: asset('ffmpeg', '6.0', 'none') },
      python: { assets: asset('python', '3.12.14', 'tar.gz', 'python/bin/python3') }
    },
    pythonPackages: {
      'gallery-dl': { requirement: 'gallery-dl', version: '1.32.9', ...lockOf(GDL_LOCK) },
      'yt-dlp': { requirement: 'yt-dlp[default]', version: '2025.11.12', ...lockOf(YTDLP_LOCK) }
    }
  });
  assert.ok(parsed.ok);
  return resolvePlatform(parsed.value, 'linux', 'x64');
}

function harness(
  options: { isPackaged?: boolean; unpinned?: ToolId; locks?: LockState; settings?: Partial<HostSettings> } = {}
) {
  const probe = new FakeProbe();
  const downloader = new FakeDownloader();
  for (const tool of Object.keys(URL) as ToolId[]) downloader.shaByUrl.set(URL[tool], SHA[tool]);
  const installer = new FakeInstaller(probe);
  const pip = new FakePip(probe);
  const extractor = new FakeExtractor();
  const releases = new FakeReleases();
  const settings = new FakeSettings(options.settings);
  const events = new FakeEvents();
  const logger = new FakeLogger();
  const clock = new ManualClock();
  let counter = 0;
  const service = new RuntimeToolsService({
    manifest: manifestFor(options.unpinned ?? null, options.locks),
    isPackaged: options.isPackaged ?? true,
    probe,
    downloader,
    extractor,
    installer,
    pip,
    releases,
    settings,
    events,
    logger,
    clock,
    newId: () => `op-${(counter += 1)}`
  });
  const finished = async (operationId: string) => {
    await waitFor(() => events.ofType('runtime.operationFinished').some((e) => e.operationId === operationId));
    const event = events.ofType('runtime.operationFinished').find((e) => e.operationId === operationId);
    assert.ok(event);
    return event;
  };
  const progress = (operationId: string): RuntimeProgressDto[] =>
    events
      .ofType('runtime.progress')
      .map((e) => e.progress)
      .filter((p) => p.operationId === operationId);
  return {
    service,
    probe,
    downloader,
    installer,
    pip,
    extractor,
    releases,
    settings,
    events,
    logger,
    clock,
    finished,
    progress
  };
}

type Harness = ReturnType<typeof harness>;

const SYSTEM_VERSIONS: Record<ToolId, string> = {
  'gallery-dl': '1.32.9',
  'yt-dlp': '2025.11.12',
  deno: 'deno 2.5.6 (stable, release, x86_64-unknown-linux-gnu)',
  ffmpeg: 'ffmpeg version 7.1 Copyright (c) 2000-2025',
  python: 'Python 3.12.14'
};

function presentAsSystem(h: Harness, ...tools: ToolId[]): void {
  for (const tool of tools) h.probe.tools.set(tool, probed(`/usr/bin/${tool}`, 'system', SYSTEM_VERSIONS[tool]));
}

function started(result: ReturnType<RuntimeToolsService['startInstall']>): string {
  assert.ok(result.ok, result.ok ? '' : result.error.code);
  return result.value.operationId;
}

describe('RuntimeToolsService operations', () => {
  it('is single-flight and refuses mutations while downloads are active', async () => {
    const h = harness();
    await h.service.refresh();
    h.downloader.hold();
    const id = started(h.service.startInstall('standalone'));
    assert.equal(h.service.isBusy(), true);
    assert.equal(h.service.status().operation?.kind, 'install');
    const second = h.service.startInstall('standalone');
    assert.deepEqual(second.ok ? null : second.error, { code: ErrorCode.TOOLS_BUSY });
    assert.equal(h.service.startCheckUpdates().ok, false);
    h.downloader.release();
    assert.equal((await h.finished(id)).ok, true);
    assert.equal(h.service.isBusy(), false);

    h.service.setDownloadsActiveProbe(() => true);
    const refused = h.service.startUpdate(null);
    assert.deepEqual(refused.ok ? null : refused.error, { code: ErrorCode.TOOLS_DOWNLOADS_ACTIVE });
    assert.equal(h.service.startCheckUpdates().ok, true, 'checking for updates does not touch tools');
  });

  it('installs only missing tools and reports monotonic step percentages', async () => {
    const h = harness();
    presentAsSystem(h, 'gallery-dl', 'yt-dlp');
    await h.service.refresh();
    assert.equal(h.service.status().setupNeeded, true);
    const id = started(h.service.startInstall('standalone'));
    const done = await h.finished(id);
    assert.equal(done.ok, true);
    assert.deepEqual(
      h.downloader.requests.map((r) => r.tool),
      ['deno', 'ffmpeg']
    );
    assert.deepEqual(h.extractor.calls, ['deno']);

    const events = h.progress(id);
    const steps = events
      .filter((p) => p.tool !== null)
      .map((p) => `${p.tool}:${p.code}:${p.percent}:${p.step}/${p.totalSteps}`);
    assert.deepEqual(steps, [
      'deno:preparing:0:1/2',
      'deno:downloading:0:1/2',
      'deno:downloadingPercent:0:1/2',
      'deno:downloadingPercent:20:1/2',
      'deno:downloadingPercent:40:1/2',
      'deno:verifying:41:1/2',
      'deno:extracting:43:1/2',
      'deno:installing:46:1/2',
      'deno:installed:50:1/2',
      'ffmpeg:preparing:50:2/2',
      'ffmpeg:downloading:50:2/2',
      'ffmpeg:downloadingPercent:50:2/2',
      'ffmpeg:downloadingPercent:70:2/2',
      'ffmpeg:downloadingPercent:90:2/2',
      'ffmpeg:verifying:91:2/2',
      'ffmpeg:installing:96:2/2',
      'ffmpeg:installed:100:2/2'
    ]);
    const first = events[0];
    const last = events.at(-1);
    assert.deepEqual([first?.phase, first?.code, first?.tool], ['start', 'install', null]);
    assert.deepEqual([last?.phase, last?.code, last?.percent], ['done', 'done', 100]);
    assert.equal(h.service.status().setupNeeded, false);
    assert.equal(h.settings.current.setupDismissed, true);
    assert.equal(h.installer.metas.get('deno')?.sha256, SHA.deno);
  });

  it('rejects a download whose SHA-256 does not match and keeps going with other tools', async () => {
    const h = harness();
    presentAsSystem(h, 'gallery-dl', 'yt-dlp');
    h.downloader.shaByUrl.set(URL.deno, 'e'.repeat(64));
    const id = started(h.service.startInstall('standalone'));
    const done = await h.finished(id);
    assert.deepEqual(done.error, { code: ErrorCode.TOOLS_INTEGRITY_FAILED, params: { tool: 'deno' } });
    assert.deepEqual(
      h.installer.executables.map((r) => r.tool),
      ['ffmpeg']
    );
    assert.ok(
      h.installer.released.some((s) => s.downloadPath.includes('deno')),
      'staging of the bad file is deleted'
    );
    const toolError = h.progress(id).find((p) => p.phase === 'error' && p.tool === 'deno');
    assert.equal(toolError?.code, 'toolFailed');
    assert.equal(h.settings.current.setupDismissed, false);
  });

  it('refuses unpinned assets in packaged builds and allows them in dev builds', async () => {
    const packaged = harness({ isPackaged: true, unpinned: 'ffmpeg' });
    const refused = packaged.service.startInstall('standalone');
    assert.deepEqual(refused.ok ? null : refused.error, { code: ErrorCode.TOOLS_NOT_PINNED });
    assert.equal(packaged.service.status().integrityPinned, false);

    const dev = harness({ isPackaged: false, unpinned: 'ffmpeg' });
    presentAsSystem(dev, 'gallery-dl', 'yt-dlp', 'deno');
    const id = started(dev.service.startInstall('standalone'));
    assert.equal((await dev.finished(id)).ok, true);
    assert.ok(dev.logger.lines.some((l) => l.level === 'warn' && l.message.includes('without a pinned SHA-256')));
  });

  it('installs python mode (managed Python + pinned pip packages) and switches mode only on success', async () => {
    const h = harness();
    presentAsSystem(h, 'deno', 'ffmpeg');
    h.pip.failWith = { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'pip' } };
    const failed = await h.finished(started(h.service.startInstall('python')));
    assert.equal(failed.ok, false);
    assert.equal(h.settings.current.runtimeMode, 'standalone');
    assert.equal(h.installer.pythons.length, 0, 'a Python without its engines is not installed');

    h.pip.failWith = null;
    const id = started(h.service.startInstall('python'));
    assert.equal((await h.finished(id)).ok, true);
    assert.deepEqual(h.pip.calls.at(-1), {
      // Into the staged distribution, before it is swapped in.
      python: '/rt/.tmp/python-extract/python/bin/python3',
      requirements: ['gallery-dl==1.32.9', 'yt-dlp[default]==2025.11.12'],
      // Both engines' locks, the shared dependency once.
      lock: [GDL_LOCK[0], GDL_LOCK[1], YTDLP_LOCK[0], YTDLP_LOCK[2]]
    });
    assert.equal(h.settings.current.runtimeMode, 'python');
    assert.equal(h.service.status().setupNeeded, false);
    assert.equal(h.service.status().integrityPinned, true);
    assert.deepEqual(h.service.resolveEngine('yt-dlp'), {
      path: '/rt/python/bin/python3',
      prefixArgs: ['-m', 'yt_dlp']
    });
    assert.ok(h.progress(id).some((p) => p.code === 'pipProgress' && p.params['package'] === 'yt-dlp'));
  });

  it('refuses python mode in packaged builds without a hash lock; dev builds warn and install the pins', async () => {
    const packaged = harness({ locks: 'none' });
    presentAsSystem(packaged, 'deno', 'ffmpeg');
    await packaged.service.refresh();
    const refused = packaged.service.startInstall('python');
    const notPinned = { code: ErrorCode.TOOLS_NOT_PINNED, params: { tool: 'python' } };
    assert.deepEqual(refused.ok ? null : refused.error, notPinned);
    assert.equal(packaged.downloader.requests.length, 0, 'refused before Python is downloaded');
    assert.equal(packaged.service.status().integrityPinned, true, 'standalone mode does not need the lock');
    await packaged.service.setMode('python');
    assert.equal(packaged.service.status().integrityPinned, false);

    const dev = harness({ isPackaged: false, locks: 'none' });
    presentAsSystem(dev, 'deno', 'ffmpeg');
    const id = started(dev.service.startInstall('python'));
    assert.equal((await dev.finished(id)).ok, true);
    assert.deepEqual(dev.pip.calls.at(-1)?.lock, null);
    assert.deepEqual(dev.pip.calls.at(-1)?.requirements, ['gallery-dl==1.32.9', 'yt-dlp[default]==2025.11.12']);
    assert.ok(dev.logger.lines.some((l) => l.level === 'warn' && l.message.includes('without a hash lock')));
  });

  it('updates the managed Python in python mode together with its engines, or not at all', async () => {
    const h = harness({ settings: { runtimeMode: 'python' } });
    presentAsSystem(h, 'deno', 'ffmpeg');
    const managed = '/rt/python/bin/python3';
    h.probe.tools.set('python', probed(managed, 'managed', 'Python 3.12.1'));
    h.installer.metas.set('python', {
      tool: 'python',
      version: '3.12.1',
      sha256: SHA.python,
      source: URL.python,
      installedAt: 1
    });
    h.probe.modules.set('yt-dlp', probed(managed, 'python', '2025.11.12', ['-m', 'yt_dlp']));
    h.probe.modules.set('gallery-dl', probed(managed, 'python', '1.32.9', ['-m', 'gallery_dl']));
    await h.service.refresh();

    h.pip.failWith = { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'ERROR: no wheel' } };
    const failed = await h.finished(started(h.service.startUpdate(['python'])));
    assert.deepEqual(failed.error, h.pip.failWith, 'the failure is reported, not a silent success');
    assert.equal(h.installer.pythons.length, 0);
    assert.deepEqual(h.service.resolveEngine('yt-dlp'), { path: managed, prefixArgs: ['-m', 'yt_dlp'] });
    assert.equal(h.service.status().tools.find((t) => t.id === 'python')?.version, '3.12.1');

    h.pip.failWith = null;
    const id = started(h.service.startUpdate(['python']));
    assert.equal((await h.finished(id)).ok, true);
    assert.deepEqual(h.pip.calls.at(-1)?.requirements, ['gallery-dl==1.32.9', 'yt-dlp[default]==2025.11.12']);
    assert.equal(h.pip.calls.at(-1)?.python, '/rt/.tmp/python-extract/python/bin/python3');
    assert.equal(h.service.status().tools.find((t) => t.id === 'python')?.version, '3.12.14');
    assert.deepEqual(h.service.resolveEngine('gallery-dl'), { path: managed, prefixArgs: ['-m', 'gallery_dl'] });
    assert.equal(h.service.status().setupNeeded, false, 'no engine went missing');
  });

  it('refuses python mode where the manifest marks it unsupported; standalone mode is unaffected', async () => {
    const h = harness({ locks: 'unsupported' });
    presentAsSystem(h, 'deno', 'ffmpeg');
    await h.service.refresh();
    const refused = h.service.startInstall('python');
    assert.deepEqual(refused.ok ? null : refused.error, {
      code: ErrorCode.TOOLS_UNSUPPORTED_PLATFORM,
      params: { tool: 'python', reason: 'pythonMode' }
    });
    assert.equal(h.downloader.requests.length, 0);
    await h.service.setMode('python');
    assert.equal(h.service.status().integrityPinned, true, 'not a missing pin: python mode has its own error');

    await h.service.setMode('standalone');
    const id = started(h.service.startInstall('standalone'));
    assert.equal((await h.finished(id)).ok, true);
    assert.deepEqual(
      h.downloader.requests.map((r) => r.tool),
      ['gallery-dl', 'yt-dlp']
    );
  });

  it('refuses a python-mode update before replacing the managed Python when pip would be refused', async () => {
    const h = harness({ locks: 'none', settings: { runtimeMode: 'python' } });
    presentAsSystem(h, 'deno', 'ffmpeg');
    h.probe.tools.set('python', probed('/rt/python/bin/python3', 'managed', 'Python 3.12.1'));
    h.installer.metas.set('python', {
      tool: 'python',
      version: '3.12.1',
      sha256: SHA.python,
      source: URL.python,
      installedAt: 1
    });
    h.probe.modules.set('yt-dlp', probed('/rt/python/bin/python3', 'python', '2025.10.22', ['-m', 'yt_dlp']));
    h.probe.modules.set('gallery-dl', probed('/rt/python/bin/python3', 'python', '1.32.9', ['-m', 'gallery_dl']));
    await h.service.refresh();
    const notPinned = { code: ErrorCode.TOOLS_NOT_PINNED, params: { tool: 'python' } };
    for (const tools of [['python'], ['yt-dlp'], null] as const) {
      const refused = h.service.startUpdate(tools);
      assert.deepEqual(refused.ok ? null : refused.error, notPinned, String(tools));
    }
    assert.equal(h.downloader.requests.length, 0, 'the managed Python is not downloaded');
    assert.equal(h.pip.calls.length, 0);
    // Tools outside python mode still update.
    assert.equal(h.service.startUpdate(['deno']).ok, true);
  });

  it('keeps python-mode engines on the manifest pin even when a newer upstream release is known', async () => {
    const toolUpdates = { checkedAt: 1, latest: { 'yt-dlp': '2026.01.15' } };
    const h = harness({ settings: { runtimeMode: 'python', toolUpdates } });
    presentAsSystem(h, 'deno', 'ffmpeg', 'python');
    h.probe.modules.set('yt-dlp', probed('/usr/bin/python', 'python', '2025.11.12', ['-m', 'yt_dlp']));
    h.probe.modules.set('gallery-dl', probed('/usr/bin/python', 'python', '1.32.9', ['-m', 'gallery_dl']));
    await h.service.refresh();
    const status = h.service.status().tools.find((t) => t.id === 'yt-dlp');
    assert.deepEqual(
      [status?.pinnedVersion, status?.latestVersion, status?.updateAvailable],
      ['2025.11.12', '2025.11.12', false]
    );
    const id = started(h.service.startUpdate(['yt-dlp']));
    assert.equal((await h.finished(id)).ok, true);
    assert.equal(h.progress(id).at(-1)?.code, 'upToDate');
    assert.equal(h.pip.calls.length, 0);

    // An older install is brought to the pin (the manifest moved with an app update), never beyond it.
    h.probe.modules.set('yt-dlp', probed('/usr/bin/python', 'python', '2025.10.22', ['-m', 'yt_dlp']));
    await h.service.refresh();
    const update = started(h.service.startUpdate(['yt-dlp']));
    assert.equal((await h.finished(update)).ok, true);
    assert.deepEqual(h.pip.calls.at(-1)?.requirements, ['yt-dlp[default]==2025.11.12']);
    assert.deepEqual(h.pip.calls.at(-1)?.lock, YTDLP_LOCK);
  });

  it('persists the mode and re-probes on setMode', async () => {
    const h = harness();
    await h.service.setMode('python');
    assert.equal(h.settings.current.runtimeMode, 'python');
    assert.equal(h.settings.current.setupDismissed, true);
    assert.equal(h.probe.calls.at(-1), 'python');
    assert.equal(h.service.status().mode, 'python');
    h.service.dismissSetup();
    assert.equal(h.settings.current.setupDismissed, true);
  });

  it('reports nothing to do for an update when everything is current', async () => {
    const h = harness();
    presentAsSystem(h, 'gallery-dl', 'yt-dlp', 'deno', 'ffmpeg');
    const id = started(h.service.startUpdate(null));
    assert.equal((await h.finished(id)).ok, true);
    assert.equal(h.progress(id).at(-1)?.code, 'upToDate');
    assert.equal(h.downloader.requests.length, 0);
  });

  it('aborts the in-flight operation on dispose', async () => {
    const h = harness();
    h.downloader.hold();
    const id = started(h.service.startInstall('standalone'));
    await waitFor(() => h.downloader.requests.length > 0);
    await h.service.dispose();
    const done = await h.finished(id);
    assert.deepEqual(done.error, { code: ErrorCode.CANCELLED });
    assert.equal(h.service.isBusy(), false);
    assert.deepEqual(h.service.startInstall('standalone').ok, false);
  });
});

describe('RuntimeToolsService update checks', () => {
  function withManagedYtDlp(h: Harness): void {
    presentAsSystem(h, 'gallery-dl', 'deno', 'ffmpeg');
    h.probe.tools.set('yt-dlp', probed('/rt/bin/yt-dlp', 'managed', '2025.11.12'));
    h.installer.metas.set('yt-dlp', {
      tool: 'yt-dlp',
      version: '2025.11.12',
      sha256: SHA['yt-dlp'],
      source: URL['yt-dlp'],
      installedAt: 1
    });
  }

  it('publishes the update notice, installs the verified latest release and dismisses the notice', async () => {
    const h = harness();
    withManagedYtDlp(h);
    const latestUrl = 'https://gh.test/yt/2026.01.15/yt-dlp_linux';
    const latestSha = '9'.repeat(64);
    h.releases.latestResult = {
      ok: true,
      value: {
        repo: 'yt-dlp/yt-dlp',
        tag: '2026.01.15',
        assets: [
          { name: 'yt-dlp_linux', url: latestUrl, size: 100 },
          { name: 'SHA2-256SUMS', url: 'https://gh.test/yt/sums', size: 10 }
        ]
      }
    };
    h.releases.texts.set('https://gh.test/yt/sums', `${latestSha}  yt-dlp_linux\n${'8'.repeat(64)}  yt-dlp.exe\n`);
    h.downloader.shaByUrl.set(latestUrl, latestSha);
    await h.service.refresh();
    assert.equal(h.events.ofType('notice').length, 0);

    h.clock.value = 5_000;
    const check = started(h.service.startCheckUpdates());
    assert.equal((await h.finished(check)).ok, true);
    assert.equal(h.progress(check).at(-1)?.code, 'updatesFound');
    assert.deepEqual(h.settings.current.toolUpdates, { checkedAt: 5_000, latest: { 'yt-dlp': '2026.01.15' } });
    const notice = h.events.ofType('notice').at(-1)?.notice;
    assert.equal(notice?.id, 'runtime-updates');
    assert.equal(notice?.code, 'runtimeUpdatesAvailable');
    assert.deepEqual(notice?.action, { type: 'runtime-update', tools: ['yt-dlp'] });
    assert.deepEqual(
      [notice?.params['count'], notice?.params['current'], notice?.params['latest']],
      [1, '2025.11.12', '2026.01.15']
    );
    const status = h.service.status().tools.find((t) => t.id === 'yt-dlp');
    assert.deepEqual(
      [status?.pinnedVersion, status?.latestVersion, status?.updateAvailable],
      ['2025.11.12', '2026.01.15', true]
    );

    const dismissedBefore = h.events.ofType('notice.dismissed').length;
    const update = started(h.service.startUpdate(notice ? (notice.action?.tools ?? null) : null));
    assert.equal((await h.finished(update)).ok, true);
    const request = h.downloader.requests.at(-1);
    assert.deepEqual([request?.url, request?.expectedBytes], [latestUrl, 100]);
    assert.equal(h.installer.metas.get('yt-dlp')?.version, '2026.01.15');
    assert.equal(h.events.ofType('notice.dismissed').length, dismissedBefore + 1);
    assert.equal(h.settings.current.runtimeMode, 'standalone', 'updates never switch the mode');
  });

  it('keeps the previous check time when the check fails (rate limit / offline)', async () => {
    const h = harness({ settings: { toolUpdates: { checkedAt: 42, latest: {} } } });
    withManagedYtDlp(h);
    h.releases.latestResult = {
      ok: false,
      error: { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool: 'yt-dlp/yt-dlp', detail: 'rate-limited' } }
    };
    const id = started(h.service.startCheckUpdates());
    const done = await h.finished(id);
    assert.deepEqual(done.error, {
      code: ErrorCode.TOOLS_NETWORK_FAILED,
      params: { tool: 'yt-dlp', detail: 'rate-limited' }
    });
    assert.equal(h.settings.current.toolUpdates.checkedAt, 42);
  });

  it('refuses a latest release without a matching checksum', async () => {
    const h = harness({ settings: { toolUpdates: { checkedAt: 1, latest: { 'yt-dlp': '2026.01.15' } } } });
    withManagedYtDlp(h);
    h.releases.latestResult = {
      ok: true,
      value: {
        repo: 'yt-dlp/yt-dlp',
        tag: '2026.01.15',
        assets: [{ name: 'yt-dlp_linux', url: 'https://gh.test/new', size: null }]
      }
    };
    const done = await h.finished(started(h.service.startUpdate(['yt-dlp'])));
    assert.deepEqual(done.error, { code: ErrorCode.TOOLS_INTEGRITY_FAILED, params: { tool: 'yt-dlp' } });
    assert.equal(h.downloader.requests.length, 0);
  });
});

describe('RuntimeToolsService auto-install and registry', () => {
  it('auto-installs missing tools once, unless setup was dismissed', async () => {
    const h = harness();
    h.service.autoInstallMissing();
    h.service.autoInstallMissing();
    await h.finished('op-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.events.ofType('runtime.operationFinished').length, 1);
    assert.deepEqual(
      h.downloader.requests.map((r) => r.tool),
      ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg']
    );

    const dismissed = harness({ settings: { setupDismissed: true } });
    dismissed.service.autoInstallMissing();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dismissed.downloader.requests.length, 0);
  });

  it('publishes an error notice when the auto-install fails', async () => {
    const h = harness();
    presentAsSystem(h, 'gallery-dl', 'yt-dlp');
    h.downloader.failWith = { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool: 'deno', detail: 'ENOTFOUND' } };
    h.service.autoInstallMissing();
    await h.finished('op-1');
    await waitFor(() => h.events.ofType('notice').some((e) => e.notice.code === 'autoInstallFailed'));
    const notice = h.events.ofType('notice').find((e) => e.notice.code === 'autoInstallFailed')?.notice;
    assert.deepEqual(notice?.params, { tools: 'Deno, ffmpeg', error: ErrorCode.TOOLS_NETWORK_FAILED });
    assert.deepEqual(notice?.action, { type: 'runtime-update', tools: ['deno', 'ffmpeg'] });
  });

  it('exposes resolved executables and PATH entries', async () => {
    const h = harness();
    presentAsSystem(h, 'gallery-dl', 'yt-dlp', 'deno', 'ffmpeg');
    let changes = 0;
    h.service.onChange(() => (changes += 1));
    await h.service.refresh();
    assert.ok(changes > 0);
    assert.deepEqual(h.service.resolveEngine('gallery-dl'), { path: '/usr/bin/gallery-dl', prefixArgs: [] });
    assert.equal(h.service.resolveHelper('ffmpeg'), '/usr/bin/ffmpeg');
    assert.deepEqual(h.service.pathEntries(), ['/rt/bin', '/usr/bin']);
    assert.deepEqual(h.service.engines()['yt-dlp'], {
      engine: 'yt-dlp',
      available: true,
      version: '2025.11.12',
      source: 'system'
    });
    const deno = h.service.status().tools.find((t) => t.id === 'deno');
    assert.equal(deno?.version, '2.5.6');
  });
});
