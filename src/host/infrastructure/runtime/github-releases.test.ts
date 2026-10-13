import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { GithubReleases } from './github-releases.ts';
import type { HttpGet } from './https-client.ts';
import { loadPlatformManifest, loadRuntimeManifest } from './manifest-loader.ts';

function fakeGet(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): HttpGet & { urls: string[]; agents: string[] } {
  const urls: string[] = [];
  const agents: string[] = [];
  const get: HttpGet = async (url, init) => {
    urls.push(url.href);
    agents.push(init.headers['User-Agent'] ?? '');
    return { statusCode: status, headers, body: Readable.from([Buffer.from(body)]) };
  };
  return Object.assign(get, { urls, agents });
}

const signal = new AbortController().signal;

describe('GithubReleases', () => {
  it('reads the latest release with a User-Agent', async () => {
    const get = fakeGet(
      200,
      JSON.stringify({
        tag_name: '2026.01.15',
        name: 'yt-dlp 2026.01.15',
        assets: [
          {
            name: 'yt-dlp.exe',
            browser_download_url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.01.15/yt-dlp.exe',
            size: 18000000,
            extra: true
          }
        ]
      })
    );
    const api = new GithubReleases({ userAgent: 'Yami/2.0.0', get });
    const result = await api.latest('yt-dlp/yt-dlp', signal);
    assert.ok(result.ok);
    assert.equal(result.value.tag, '2026.01.15');
    assert.deepEqual(result.value.assets[0], {
      name: 'yt-dlp.exe',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.01.15/yt-dlp.exe',
      size: 18000000
    });
    assert.deepEqual(get.urls, ['https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest']);
    assert.deepEqual(get.agents, ['Yami/2.0.0']);
  });

  it('reports rate limits, HTTP errors and bad payloads as network failures', async () => {
    const limited = await new GithubReleases({
      userAgent: 'x',
      get: fakeGet(403, '{}', { 'x-ratelimit-remaining': '0' })
    }).latest('a/b', signal);
    assert.deepEqual(limited.ok ? null : limited.error, {
      code: ErrorCode.TOOLS_NETWORK_FAILED,
      params: { tool: 'a/b', detail: 'rate-limited' }
    });
    const missing = await new GithubReleases({ userAgent: 'x', get: fakeGet(404, '') }).latest('a/b', signal);
    assert.equal(missing.ok ? null : missing.error.params?.['detail'], 'HTTP 404');
    const garbage = await new GithubReleases({ userAgent: 'x', get: fakeGet(200, '<html>') }).latest('a/b', signal);
    assert.equal(garbage.ok ? null : garbage.error.code, ErrorCode.TOOLS_NETWORK_FAILED);
    const badRepo = await new GithubReleases({ userAgent: 'x', get: fakeGet(200, '{}') }).latest('../../x', signal);
    assert.equal(badRepo.ok, false);
  });

  it('fetches small text documents with a size cap', async () => {
    const api = new GithubReleases({ userAgent: 'x', get: fakeGet(200, 'a'.repeat(100)) });
    assert.ok((await api.fetchText('https://example.test/SHA2-256SUMS', 1_000, signal)).ok);
    const tooBig = await api.fetchText('https://example.test/SHA2-256SUMS', 10, signal);
    assert.equal(tooBig.ok ? null : tooBig.error.code, ErrorCode.TOOLS_INSTALL_FAILED);
  });
});

describe('embedded runtime manifest', () => {
  it('is valid and covers the supported platforms', () => {
    const manifest = loadRuntimeManifest();
    for (const key of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64']) {
      const view = loadPlatformManifest(
        key.startsWith('win32') ? 'win32' : key.startsWith('darwin') ? 'darwin' : 'linux',
        key.split('-')[1] ?? ''
      );
      for (const tool of ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'] as const)
        assert.ok(view.asset(tool), `${tool} on ${key}`);
    }
    assert.deepEqual(manifest.tools['yt-dlp'].latest, { repo: 'yt-dlp/yt-dlp', checksumsAsset: 'SHA2-256SUMS' });
    assert.deepEqual(Object.keys(manifest.tools.ffmpeg.assets['win32-x64']?.companions ?? {}), ['ffprobe']);
    assert.equal(manifest.tools.python.assets['win32-x64']?.entry, 'python/python.exe');
    assert.equal(manifest.tools.python.assets['linux-x64']?.entry, 'python/bin/python3');
    assert.equal(
      loadPlatformManifest('linux', 'arm64').asset('gallery-dl'),
      null,
      'no official gallery-dl build for linux-arm64'
    );
  });

  it('rejects an invalid manifest', () => {
    assert.throws(() => loadRuntimeManifest({ schemaVersion: 1 }), /Invalid runtime manifest/);
  });
});
