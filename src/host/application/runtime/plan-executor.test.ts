import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import type { RuntimeMode } from '../../../shared/domain/engine.ts';
import type { RuntimeProgressDto } from '../../../shared/contracts/dto.ts';
import type { PlanStep } from './install-plan.ts';
import { parseManifest, resolvePlatform } from './manifest.ts';
import { executePlan } from './plan-executor.ts';
import { OperationProgress } from './progress.ts';
import {
  FakeDownloader,
  FakeExtractor,
  FakeInstaller,
  FakeLogger,
  FakePip,
  FakeProbe,
  FakeReleases,
  ManualClock,
  probed
} from './testing-fakes.ts';

const SHA = 'a'.repeat(64);
const PYTHON_URL = 'https://gh.test/pbs/cpython-3.12.14.tar.gz';

function manifest(lock: unknown) {
  const asset = (archive: string, entry?: string) => ({
    'linux-x64': { version: '1.0', url: 'https://gh.test/tool', sha256: SHA, archive, ...(entry ? { entry } : {}) }
  });
  const python = {
    'linux-x64': { version: '3.12.14', url: PYTHON_URL, sha256: SHA, archive: 'tar.gz', entry: 'python/bin/python3' }
  };
  const lockOf = (wheels: unknown) =>
    lock === undefined ? {} : { lock: { 'linux-x64': lock === 'wheels' ? wheels : lock } };
  const parsed = parseManifest({
    schemaVersion: 1,
    tools: {
      'gallery-dl': { assets: asset('none') },
      'yt-dlp': { assets: asset('none') },
      deno: { assets: asset('zip', 'deno') },
      ffmpeg: { assets: asset('none') },
      python: { assets: python }
    },
    pythonPackages: {
      'gallery-dl': {
        requirement: 'gallery-dl',
        version: '1.32.9',
        ...lockOf([{ name: 'gallery-dl', version: '1.32.9', sha256: [SHA] }])
      },
      'yt-dlp': {
        requirement: 'yt-dlp[default]',
        version: '2025.11.12',
        ...lockOf([{ name: 'yt-dlp', version: '2025.11.12', sha256: [SHA] }])
      }
    }
  });
  assert.ok(parsed.ok);
  return resolvePlatform(parsed.value, 'linux', 'x64');
}

function run(lock: unknown, options: { packaged: boolean; mode: RuntimeMode; plan: PlanStep[]; pipFails?: boolean }) {
  const probe = new FakeProbe();
  const downloader = new FakeDownloader();
  downloader.defaultSha = SHA;
  const installer = new FakeInstaller(probe);
  const pip = new FakePip(probe);
  const clock = new ManualClock();
  const deps = {
    downloader,
    extractor: new FakeExtractor(),
    installer,
    pip,
    logger: new FakeLogger(),
    clock,
    allowUnpinned: !options.packaged,
    releases: new FakeReleases(),
    manifest: manifest(lock)
  };
  const events: RuntimeProgressDto[] = [];
  const progress = new OperationProgress('op-1', (event) => events.push(event), clock);
  const context = { progress, signal: new AbortController().signal };
  if (options.pipFails) pip.failWith = PIP_FAILURE;
  const result = executePlan(deps, options.plan, { mode: options.mode, statuses: [], latestKnown: {} }, context);
  return { result, downloader, installer, pip, probe, events };
}

const PIP_FAILURE = { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'ERROR: no wheel' } };
const STAGED_PYTHON = '/rt/.tmp/python-extract/python/bin/python3';
const PYTHON_PLAN: PlanStep[] = [{ kind: 'python', packages: ['gallery-dl', 'yt-dlp'] }];

describe('executePlan python-mode pre-flight', () => {
  it('refuses before any step (the managed Python is not replaced) in packaged builds without a lock', async () => {
    const h = run(undefined, { packaged: true, mode: 'python', plan: PYTHON_PLAN });
    const result = await h.result;
    assert.deepEqual(result.ok ? null : result.error, { code: ErrorCode.TOOLS_NOT_PINNED, params: { tool: 'python' } });
    assert.equal(h.downloader.requests.length, 0);
    assert.equal(h.installer.pythons.length, 0);
  });

  it('refuses a platform marked unsupported with its own error', async () => {
    const h = run({ unsupported: 'no wheel for brotli' }, { packaged: true, mode: 'python', plan: PYTHON_PLAN });
    const result = await h.result;
    assert.deepEqual(result.ok ? null : result.error, {
      code: ErrorCode.TOOLS_UNSUPPORTED_PLATFORM,
      params: { tool: 'python', reason: 'pythonMode' }
    });
    assert.equal(h.downloader.requests.length, 0);
  });

  it('runs locked plans, dev builds and standalone plans', async () => {
    const locked = run('wheels', { packaged: true, mode: 'python', plan: PYTHON_PLAN });
    assert.equal((await locked.result).ok, true);
    assert.equal(locked.pip.calls.length, 1);

    const dev = run(undefined, { packaged: false, mode: 'python', plan: PYTHON_PLAN });
    assert.equal((await dev.result).ok, true);
    assert.equal(dev.pip.calls[0]?.lock, null);

    // Standalone mode may update a managed Python without any pip step or lock.
    const standalone = run(undefined, { packaged: true, mode: 'standalone', plan: [{ kind: 'python', packages: [] }] });
    assert.equal((await standalone.result).ok, true);
    assert.equal(standalone.installer.pythons.length, 1);
    assert.equal(standalone.pip.calls.length, 0);
  });
});

describe('executePlan python step in python mode', () => {
  it('installs the locked engines into the staged Python, then swaps it in', async () => {
    const h = run('wheels', { packaged: true, mode: 'python', plan: PYTHON_PLAN });
    assert.equal((await h.result).ok, true);
    assert.deepEqual(
      h.pip.calls.map((c) => [c.python, c.requirements, c.lock?.map((w) => w.name)]),
      [[STAGED_PYTHON, ['gallery-dl==1.32.9', 'yt-dlp[default]==2025.11.12'], ['gallery-dl', 'yt-dlp']]]
    );
    assert.equal(h.installer.pythons.length, 1);
    assert.equal(h.probe.modules.get('yt-dlp')?.path, '/rt/python/bin/python3', 'the engines moved with it');
    const codes = h.events.map((e) => e.code);
    assert.equal(codes.includes('pipDone'), false, 'one step, one completion');
    assert.equal(codes.at(-1), 'installed');
  });

  it('fails clearly and keeps the current Python (with its engines) when the packages cannot be installed', async () => {
    const h = run('wheels', { packaged: true, mode: 'python', plan: PYTHON_PLAN, pipFails: true });
    h.probe.modules.set('yt-dlp', probed('/rt/python/bin/python3', 'python', '2025.10.22', ['-m', 'yt_dlp']));
    const result = await h.result;
    assert.deepEqual(result.ok ? null : result.error, PIP_FAILURE);
    assert.equal(h.installer.pythons.length, 0, 'not swapped in');
    assert.equal(h.installer.released.length, 1, 'staging removed');
    assert.equal(h.probe.modules.get('yt-dlp')?.path, '/rt/python/bin/python3');
    assert.ok(h.events.some((e) => e.phase === 'error' && e.code === 'toolFailed'));
  });
});
