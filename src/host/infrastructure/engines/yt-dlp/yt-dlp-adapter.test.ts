import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvocationContext } from '../../../application/ports/engines.ts';
import { YtDlpAdapter } from './yt-dlp-adapter.ts';
import { YTDLP_OUTPUT_TEMPLATE } from './yt-dlp-args.ts';

function context(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    url: 'https://example.com/watch?v=1',
    downloadDir: 'C:\\Users\\João\\Downloads\\Yami\\yt-dlp',
    tempDir: 'C:\\Users\\João\\AppData\\Roaming\\Yami\\data\\work\\d1\\tmp',
    executable: { path: 'C:\\Yami\\bin\\yt-dlp.exe', prefixArgs: [] },
    ffmpegPath: null,
    denoPath: null,
    cookieFile: null,
    browserCookies: null,
    secretConfigFile: null,
    platform: 'win32',
    ...overrides
  };
}

function argsOf(overrides: Partial<InvocationContext> = {}): readonly string[] {
  return new YtDlpAdapter().buildInvocation(context(overrides)).args;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe('YtDlpAdapter.buildInvocation (legacy buildArgs)', () => {
  it('passes URL last and never uses a shell string', () => {
    const invocation = new YtDlpAdapter().buildInvocation(context());
    const args = invocation.args;
    assert.equal(invocation.executable, 'C:\\Yami\\bin\\yt-dlp.exe');
    assert.equal(args[args.length - 1], 'https://example.com/watch?v=1');
    assert.ok(args.includes('--windows-filenames'));
    assert.ok(args.includes('--continue'));
    assert.ok(args.includes('--no-overwrites'));
    assert.equal(valueAfter(args, '--remote-components'), 'ejs:github');
    assert.ok(args.every((arg) => typeof arg === 'string'));
  });

  it('never enables a bare `deno` from PATH when no Deno was resolved', () => {
    const args = argsOf({ denoPath: null });
    assert.ok(args.includes('--no-js-runtimes'));
    assert.equal(args.includes('--js-runtimes'), false);
    assert.equal(args.includes('deno'), false);
    assert.equal(args.indexOf('--no-js-runtimes') < args.indexOf('--'), true);
  });

  it('omits merge and embed flags when ffmpeg is missing', () => {
    const args = argsOf();
    assert.equal(valueAfter(args, '--format'), 'b/bv/ba');
    for (const flag of [
      '--merge-output-format',
      '--remux-video',
      '--embed-subs',
      '--embed-metadata',
      '--ffmpeg-location',
      '--write-info-json',
      '--write-description',
      '--write-subs'
    ]) {
      assert.equal(args.includes(flag), false, flag);
    }
    assert.ok(args.includes('--write-thumbnail'));
  });

  it('uses merged format and embed flags when ffmpeg is present', () => {
    const ffmpegPath = 'C:\\Tools\\ffmpeg.exe';
    const args = argsOf({ ffmpegPath });
    assert.equal(valueAfter(args, '--format'), 'bv*+ba/b');
    assert.equal(valueAfter(args, '--merge-output-format'), 'mp4/webm');
    // Q8: keep webm, remux everything else to mp4 (legacy `mp4/webm` never reached webm).
    assert.equal(valueAfter(args, '--remux-video'), 'webm>webm/mp4');
    assert.ok(args.includes('--embed-metadata'));
    assert.ok(args.includes('--write-thumbnail'));
    for (const flag of ['--embed-subs', '--write-info-json', '--write-description', '--write-subs']) {
      assert.equal(args.includes(flag), false, flag);
    }
    assert.equal(valueAfter(args, '--ffmpeg-location'), ffmpegPath);
  });

  it('points yt-dlp at a managed Deno runtime', () => {
    const args = argsOf({ denoPath: 'C:\\Users\\PC\\.yami\\bin\\deno.exe' });
    assert.equal(valueAfter(args, '--js-runtimes'), 'deno:C:\\Users\\PC\\.yami\\bin\\deno.exe');
    assert.equal(valueAfter(args, '--remote-components'), 'ejs:github');
    assert.equal(args.includes('--no-js-runtimes'), false);
  });

  it('passes cookies-from-browser when no cookie file is set', () => {
    const args = argsOf({ url: 'https://www.youtube.com/watch?v=1', browserCookies: 'chrome' });
    assert.equal(valueAfter(args, '--cookies-from-browser'), 'chrome');
    assert.equal(args.includes('--cookies'), false);
  });

  it('prefers a cookie file over cookies-from-browser', () => {
    const cookieFile = 'C:\\Users\\PC\\AppData\\Roaming\\Yami\\data\\work\\d1\\cookies.txt';
    const args = argsOf({ cookieFile, browserCookies: 'chrome' });
    assert.equal(valueAfter(args, '--cookies'), cookieFile);
    assert.equal(args.includes('--cookies-from-browser'), false);
  });
});

describe('YtDlpAdapter.buildInvocation (fixed quirks)', () => {
  it('puts -- right before the URL (Q2)', () => {
    const args = argsOf({ url: 'https://example.com/-x' });
    assert.deepEqual(args.slice(-2), ['--', 'https://example.com/-x']);
    assert.equal(args.filter((arg) => arg === '--').length, 1);
  });

  it('forces UTF-8 output via flag and environment (Q3)', () => {
    const invocation = new YtDlpAdapter().buildInvocation(context());
    assert.equal(valueAfter(invocation.args, '--encoding'), 'utf-8');
    assert.equal(invocation.env['PYTHONUTF8'], '1');
    assert.equal(invocation.env['PYTHONIOENCODING'], 'utf-8');
  });

  it('passes the download and private temp dirs explicitly', () => {
    const args = argsOf();
    assert.equal(valueAfter(args, '--paths'), 'C:\\Users\\João\\Downloads\\Yami\\yt-dlp');
    assert.equal(valueAfter(args, '-P'), 'temp:C:\\Users\\João\\AppData\\Roaming\\Yami\\data\\work\\d1\\tmp');
    assert.equal(valueAfter(args, '--output'), YTDLP_OUTPUT_TEMPLATE);
  });

  it('caps title/uploader length in the output template (Q34)', () => {
    assert.match(YTDLP_OUTPUT_TEMPLATE, /%\(title\)\.150B/);
    assert.match(YTDLP_OUTPUT_TEMPLATE, /%\(uploader,playlist_uploader,channel,id\)\.80B/);
  });

  it('prints machine-readable progress on new lines and keeps warnings (Q27)', () => {
    const args = argsOf();
    assert.ok(args.includes('--newline'));
    assert.match(valueAfter(args, '--progress-template') ?? '', /^download:\[yami-progress\] %\(progress\.status\)s\|/);
    assert.equal(args.includes('--no-warnings'), false);
    assert.equal(args[0], '--ignore-config');
  });

  it('never adds user-controllable execution flags', () => {
    const args = argsOf({ ffmpegPath: '/usr/bin/ffmpeg', cookieFile: '/w/c.txt' });
    for (const flag of [
      '--exec',
      '--exec-before-download',
      '--postprocessor-args',
      '--ppa',
      '--config-location',
      '--config-locations',
      '--batch-file',
      '-a'
    ]) {
      assert.equal(args.includes(flag), false, flag);
    }
  });

  it('prepends the python module prefix in python mode', () => {
    const invocation = new YtDlpAdapter().buildInvocation(
      context({ executable: { path: '/usr/bin/python3', prefixArgs: ['-m', 'yt_dlp'] } })
    );
    assert.equal(invocation.executable, '/usr/bin/python3');
    assert.deepEqual(invocation.args.slice(0, 3), ['-m', 'yt_dlp', '--ignore-config']);
  });

  it('drops an invalid browser cookie spec instead of passing it through', () => {
    assert.equal(argsOf({ browserCookies: '--exec rm' }).includes('--cookies-from-browser'), false);
    assert.equal(
      valueAfter(argsOf({ browserCookies: 'Firefox:default-release' }), '--cookies-from-browser'),
      'firefox:default-release'
    );
  });

  it('supports browser cookies for any http(s) site and needs no secret config', () => {
    const adapter = new YtDlpAdapter();
    assert.equal(adapter.supportsBrowserCookies('https://youtu.be/abc'), true);
    assert.equal(adapter.supportsBrowserCookies('https://x.com/a'), true);
    assert.equal(adapter.supportsBrowserCookies('file:///etc/passwd'), false);
    assert.equal(adapter.secretConfig(), null);
    assert.equal(adapter.slotWeight, 2);
  });
});
