import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assetFileName, parseManifest, resolvePlatform, type RuntimeManifest } from './manifest.ts';

const SHA = 'f'.repeat(64);

function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: '1.0.0', url: 'https://example.com/tool', sha256: SHA, archive: 'none', ...overrides };
}

function manifest(overrides: { tools?: Record<string, unknown> } = {}): Record<string, unknown> {
  const tool = { assets: { 'linux-x64': asset() } };
  return {
    schemaVersion: 1,
    tools: { 'gallery-dl': tool, 'yt-dlp': tool, deno: tool, ffmpeg: tool, python: tool, ...overrides.tools },
    pythonPackages: {
      'gallery-dl': { requirement: 'gallery-dl', version: '1.32.9' },
      'yt-dlp': { requirement: 'yt-dlp[default]', version: '2025.11.12' }
    }
  };
}

function parsed(input: unknown): RuntimeManifest {
  const result = parseManifest(input);
  assert.ok(result.ok, result.ok ? '' : `${result.error.path}: ${result.error.reason}`);
  return result.value;
}

describe('runtime manifest schema', () => {
  it('accepts a valid manifest', () => {
    parsed(manifest());
  });

  it('rejects http URLs, bad digests and unknown keys', () => {
    assert.equal(
      parseManifest(manifest({ tools: { deno: { assets: { 'linux-x64': asset({ url: 'http://x.org/deno' }) } } } })).ok,
      false
    );
    assert.equal(
      parseManifest(manifest({ tools: { deno: { assets: { 'linux-x64': asset({ sha256: 'XYZ' }) } } } })).ok,
      false
    );
    assert.equal(
      parseManifest(manifest({ tools: { deno: { assets: { 'linux-x64': asset({ extra: 1 }) } } } })).ok,
      false
    );
    assert.equal(parseManifest(manifest({ tools: { deno: { assets: { 'plan9-x64': asset() } } } })).ok, false);
    assert.equal(parseManifest({ ...manifest(), schemaVersion: 2 }).ok, false);
  });

  it('requires a safe entry for archives', () => {
    const noEntry = manifest({ tools: { deno: { assets: { 'linux-x64': asset({ archive: 'zip' }) } } } });
    assert.equal(parseManifest(noEntry).ok, false);
    for (const entry of ['../deno', '/abs/deno', 'a/../../deno', 'a\\deno', 'a//deno']) {
      const bad = manifest({ tools: { deno: { assets: { 'linux-x64': asset({ archive: 'zip', entry }) } } } });
      assert.equal(parseManifest(bad).ok, false, entry);
    }
    parsed(manifest({ tools: { deno: { assets: { 'linux-x64': asset({ archive: 'zip', entry: 'bin/deno' }) } } } }));
  });

  it('rejects pip requirements that could smuggle options', () => {
    const input = manifest();
    const packages = {
      'gallery-dl': { requirement: '--index-url=evil', version: '1.0' },
      'yt-dlp': { requirement: 'yt-dlp', version: '1.0' }
    };
    assert.equal(parseManifest({ ...input, pythonPackages: packages }).ok, false);
  });

  it('resolves the platform view and pinning state', () => {
    const unpinned = manifest({ tools: { ffmpeg: { assets: { 'linux-x64': asset({ sha256: null }) } } } });
    const view = resolvePlatform(parsed(unpinned), 'linux', 'x64');
    assert.equal(view.platformKey, 'linux-x64');
    assert.equal(view.fullyPinned, false);
    assert.equal(view.asset('deno')?.version, '1.0.0');
    assert.equal(resolvePlatform(parsed(manifest()), 'linux', 'x64').fullyPinned, true);
    assert.equal(resolvePlatform(parsed(manifest()), 'win32', 'x64').asset('deno'), null);
  });

  describe('python package locks', () => {
    const wheel = (name: string, version: string, sha = SHA) => ({ name, version, sha256: [sha] });
    function withLocks(gdl: unknown, ytdlp: unknown): Record<string, unknown> {
      return {
        ...manifest(),
        pythonPackages: {
          'gallery-dl': { requirement: 'gallery-dl', version: '1.32.9', ...(gdl === undefined ? {} : { lock: gdl }) },
          'yt-dlp': {
            requirement: 'yt-dlp[default]',
            version: '2025.11.12',
            ...(ytdlp === undefined ? {} : { lock: ytdlp })
          }
        }
      };
    }

    it('accepts per-platform locks and exposes them in the platform view', () => {
      const gdl = { 'linux-x64': [wheel('gallery-dl', '1.32.9'), wheel('requests', '2.32.5')] };
      const ytdlp = {
        'linux-x64': [wheel('yt_dlp', '2025.11.12'), wheel('Requests', '2.32.5', 'e'.repeat(64))],
        'win32-x64': [wheel('yt-dlp', '2025.11.12')]
      };
      const value = parsed(withLocks(gdl, ytdlp));
      const linux = resolvePlatform(value, 'linux', 'x64');
      assert.equal(linux.pythonLocked, true);
      assert.deepEqual(linux.pythonLock('gallery-dl'), gdl['linux-x64']);
      const windows = resolvePlatform(value, 'win32', 'x64');
      assert.equal(windows.pythonLock('gallery-dl'), null);
      assert.equal(windows.pythonLocked, false);
      const unlocked = resolvePlatform(parsed(manifest()), 'linux', 'x64');
      assert.equal(unlocked.pythonLocked, false, 'manifests without locks stay valid');
      assert.equal(linux.pythonUnsupported, null);
    });

    it('accepts a platform marked unsupported for python mode', () => {
      const marker = { unsupported: 'pip: no wheel for brotli on win_arm64' };
      const gdl = { 'linux-x64': [wheel('gallery-dl', '1.32.9')], 'win32-arm64': marker };
      const ytdlp = { 'linux-x64': [wheel('yt-dlp', '2025.11.12')], 'win32-arm64': marker };
      const value = parsed(withLocks(gdl, ytdlp));
      const arm = resolvePlatform(value, 'win32', 'arm64');
      assert.equal(arm.pythonUnsupported, marker.unsupported);
      assert.equal(arm.pythonLocked, false);
      assert.equal(arm.pythonLock('yt-dlp'), null);
      assert.equal(resolvePlatform(value, 'linux', 'x64').pythonUnsupported, null);
      // One engine is enough to rule python mode out.
      const partly = resolvePlatform(parsed(withLocks({ 'win32-arm64': marker }, undefined)), 'win32', 'arm64');
      assert.equal(partly.pythonUnsupported, marker.unsupported);
      for (const bad of [{ unsupported: '' }, { unsupported: 'x', extra: 1 }, { unsupported: 'a\u0000b' }]) {
        assert.equal(parseManifest(withLocks({ 'win32-arm64': bad }, undefined)).ok, false, JSON.stringify(bad));
      }
    });

    it('rejects stale, duplicated, conflicting or malformed locks', () => {
      const cases: Array<[string, unknown, unknown]> = [
        ['stale after a version bump', { 'linux-x64': [wheel('gallery-dl', '1.30.0')] }, undefined],
        ['missing the package itself', { 'linux-x64': [wheel('requests', '2.32.5')] }, undefined],
        ['duplicate entry', { 'linux-x64': [wheel('gallery-dl', '1.32.9'), wheel('Gallery_DL', '1.32.9')] }, undefined],
        [
          'engines disagree on a shared dependency',
          { 'linux-x64': [wheel('gallery-dl', '1.32.9'), wheel('requests', '2.32.4')] },
          { 'linux-x64': [wheel('yt-dlp', '2025.11.12'), wheel('requests', '2.32.5')] }
        ],
        ['option as a name', { 'linux-x64': [wheel('gallery-dl', '1.32.9'), wheel('--index', '1')] }, undefined],
        ['bad digest', { 'linux-x64': [wheel('gallery-dl', '1.32.9', 'XYZ')] }, undefined],
        ['no digest', { 'linux-x64': [{ name: 'gallery-dl', version: '1.32.9', sha256: [] }] }, undefined],
        ['empty lock', { 'linux-x64': [] }, undefined],
        ['unknown platform', { 'plan9-x64': [wheel('gallery-dl', '1.32.9')] }, undefined]
      ];
      for (const [label, gdl, ytdlp] of cases) assert.equal(parseManifest(withLocks(gdl, ytdlp)).ok, false, label);
    });
  });

  it('extracts asset file names from URLs', () => {
    assert.equal(assetFileName('https://github.com/a/b/releases/download/1/yt-dlp.exe'), 'yt-dlp.exe');
    assert.equal(
      assetFileName('https://x/cpython-3.12.14%2B20260814-x.tar.gz?y=1'),
      'cpython-3.12.14+20260814-x.tar.gz'
    );
  });
});
