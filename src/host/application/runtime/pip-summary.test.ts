import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizePipLine } from './pip-summary.ts';
import { checksumFor, parseChecksumList, sameDigest } from './checksums.ts';

describe('summarizePipLine', () => {
  it('turns pip fraction bars into a readable status', () => {
    assert.deepEqual(summarizePipLine('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 4/6 [pycryptodomex]'), {
      code: 'pipProgress',
      params: { package: 'pycryptodomex', current: 4, total: 6 },
      percent: 67
    });
    assert.deepEqual(summarizePipLine('2/4 []'), {
      code: 'pipProgressGeneric',
      params: { current: 2, total: 4 },
      percent: 50
    });
  });

  it('drops noise', () => {
    assert.equal(summarizePipLine('----------------------------------------'), null);
    assert.equal(summarizePipLine(''), null);
    assert.equal(summarizePipLine('\u0008\u0008  '), null);
    assert.equal(summarizePipLine('Requirement already satisfied: certifi in ./lib'), null);
    assert.equal(summarizePipLine('WARNING: something'), null);
    assert.equal(summarizePipLine('[notice] A new release of pip is available'), null);
  });

  it('summarizes collecting, downloading and install lines', () => {
    assert.deepEqual(summarizePipLine('Collecting gallery-dl==1.32.9'), {
      code: 'pipCollecting',
      params: { package: 'gallery-dl' },
      percent: null
    });
    assert.deepEqual(summarizePipLine('Collecting yt-dlp[default]==2025.11.12'), {
      code: 'pipCollecting',
      params: { package: 'yt-dlp' },
      percent: null
    });
    assert.deepEqual(summarizePipLine('Downloading yt_dlp-2025.10.14-py3-none-any.whl (3.2 MB)'), {
      code: 'pipDownloading',
      params: { package: 'yt_dlp' },
      percent: null
    });
    assert.deepEqual(
      summarizePipLine('Downloading https://files.pythonhosted.org/packages/ab/cd/brotli-1.1.0-cp312.whl'),
      {
        code: 'pipDownloading',
        params: { package: 'brotli' },
        percent: null
      }
    );
    assert.equal(summarizePipLine('Installing collected packages: yt-dlp')?.code, 'pipInstallingCollected');
    assert.deepEqual(summarizePipLine('Successfully installed yt-dlp-2025.11.12'), {
      code: 'pipDone',
      params: {},
      percent: 100
    });
  });
});

describe('checksum lists', () => {
  const sha = 'a'.repeat(64);
  const other = 'B'.repeat(64);

  it('parses coreutils formats', () => {
    const text = `${sha}  yt-dlp.exe\r\n${other} *yt-dlp_linux\n\nnot a line\n${'c'.repeat(64)}  ./yt-dlp_macos\n`;
    const list = parseChecksumList(text);
    assert.equal(list.get('yt-dlp.exe'), sha);
    assert.equal(list.get('yt-dlp_linux'), 'b'.repeat(64));
    assert.equal(list.get('yt-dlp_macos'), 'c'.repeat(64));
    assert.equal(checksumFor(text, 'missing'), null);
  });

  it('compares digests case-insensitively', () => {
    assert.ok(sameDigest(other, 'b'.repeat(64)));
    assert.equal(sameDigest(sha, 'b'.repeat(64)), false);
    assert.equal(sameDigest(sha, 'a'.repeat(63)), false);
  });
});
