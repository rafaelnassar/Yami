import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HostPlatform } from '../../application/ports/engines.ts';
import {
  SystemBrowserCookieDetector,
  parsePsNames,
  parseTasklistNames,
  type DirectoryProbe,
  type ProcessListRunner
} from './browser-cookie-detector.ts';
import { normalizeBrowserCookieSpec } from './browser-cookie-spec.ts';

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

class FakeRunner implements ProcessListRunner {
  readonly calls: Call[] = [];
  stdout: string;
  code: number | null;

  constructor(stdout = '', code: number | null = 0) {
    this.stdout = stdout;
    this.code = code;
  }

  async run(
    file: string,
    args: readonly string[],
    options: { readonly timeoutMs: number }
  ): Promise<{ stdout: string; code: number | null }> {
    this.calls.push({ file, args, timeoutMs: options.timeoutMs });
    return { stdout: this.stdout, code: this.code };
  }
}

function dirs(existing: readonly string[]): DirectoryProbe & { readonly probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    async isDirectory(dirPath: string): Promise<boolean> {
      probed.push(dirPath);
      return existing.includes(dirPath);
    }
  };
}

function detector(options: {
  platform: HostPlatform;
  existing: readonly string[];
  runner?: FakeRunner;
  env?: Record<string, string>;
  now?: () => number;
}): { detector: SystemBrowserCookieDetector; runner: FakeRunner; fs: ReturnType<typeof dirs> } {
  const runner = options.runner ?? new FakeRunner();
  const fs = dirs(options.existing);
  const home = options.platform === 'win32' ? 'C:\\Users\\U' : options.platform === 'darwin' ? '/Users/u' : '/home/u';
  return {
    runner,
    fs,
    detector: new SystemBrowserCookieDetector({
      platform: options.platform,
      env: options.env ?? {},
      homeDir: home,
      runner,
      fs,
      clock: { now: options.now ?? (() => 0) }
    })
  };
}

describe('SystemBrowserCookieDetector', () => {
  it('prefers a running browser over the first installed one (win32)', async () => {
    const runner = new FakeRunner(
      '"System","4","Services","0","8 K"\r\n"msedge.exe","1234","Console","1","90,000 K"\r\n'
    );
    const { detector: d } = detector({
      platform: 'win32',
      env: { LocalAppData: 'C:\\Users\\U\\AppData\\Local', SystemRoot: 'C:\\WINDOWS' },
      existing: [
        'C:\\Users\\U\\AppData\\Local\\Google\\Chrome\\User Data',
        'C:\\Users\\U\\AppData\\Local\\Microsoft\\Edge\\User Data'
      ],
      runner
    });
    assert.equal(await d.detect(), 'edge');
    assert.deepEqual(runner.calls[0], {
      file: 'C:\\WINDOWS\\System32\\tasklist.exe',
      args: ['/fo', 'csv', '/nh'],
      timeoutMs: 3000
    });
  });

  it('falls back to the first installed browser when none is running (linux)', async () => {
    const { detector: d, runner } = detector({
      platform: 'linux',
      existing: ['/home/u/.config/chromium', '/home/u/.mozilla/firefox'],
      runner: new FakeRunner('systemd\nbash\n')
    });
    assert.equal(await d.detect(), 'chromium');
    assert.deepEqual(runner.calls[0]?.args, ['-A', '-o', 'comm=']);
  });

  it('matches macOS processes printed as full paths (Q21)', async () => {
    const { detector: d } = detector({
      platform: 'darwin',
      existing: [
        '/Users/u/Library/Application Support/Google/Chrome',
        '/Users/u/Library/Application Support/Firefox/Profiles'
      ],
      runner: new FakeRunner('/sbin/launchd\n/Applications/Firefox.app/Contents/MacOS/firefox\n')
    });
    assert.equal(await d.detect(), 'firefox');
  });

  it('returns null without running processes when no browser is installed', async () => {
    const { detector: d, runner } = detector({ platform: 'linux', existing: [] });
    assert.equal(await d.detect(), null);
    assert.equal(runner.calls.length, 0);
  });

  it('treats a failing process list as "nothing running"', async () => {
    const { detector: d } = detector({
      platform: 'linux',
      existing: ['/home/u/.config/google-chrome', '/home/u/.mozilla/firefox'],
      runner: new FakeRunner('firefox\n', null)
    });
    assert.equal(await d.detect(), 'chrome');
  });

  it('honours a valid override without probing anything', async () => {
    const {
      detector: d,
      runner,
      fs
    } = detector({
      platform: 'linux',
      existing: ['/home/u/.config/google-chrome'],
      env: { YAMI_COOKIES_FROM_BROWSER: 'Firefox:default-release' }
    });
    assert.equal(await d.detect(), 'firefox:default-release');
    assert.equal(runner.calls.length, 0);
    assert.equal(fs.probed.length, 0);
  });

  it('ignores an invalid override and detects instead', async () => {
    const { detector: d } = detector({
      platform: 'linux',
      existing: ['/home/u/.config/google-chrome'],
      env: { YAMI_COOKIES_FROM_BROWSER: 'netscape; rm -rf /' }
    });
    assert.equal(await d.detect(), 'chrome');
  });

  it('caches the detection for 5 seconds', async () => {
    let now = 1000;
    const { detector: d, runner } = detector({
      platform: 'linux',
      existing: ['/home/u/.config/google-chrome'],
      runner: new FakeRunner('chrome\n'),
      now: () => now
    });
    assert.equal(await d.detect(), 'chrome');
    now += 4999;
    assert.equal(await d.detect(), 'chrome');
    assert.equal(runner.calls.length, 1);
    now += 2;
    await d.detect();
    assert.equal(runner.calls.length, 2);
  });

  it('shares one probe between concurrent calls', async () => {
    const { detector: d, runner } = detector({
      platform: 'linux',
      existing: ['/home/u/.config/google-chrome'],
      runner: new FakeRunner('chrome\n')
    });
    const results = await Promise.all([d.detect(), d.detect(), d.detect()]);
    assert.deepEqual(results, ['chrome', 'chrome', 'chrome']);
    assert.equal(runner.calls.length, 1);
  });
});

describe('process list parsing', () => {
  it('reads the first tasklist CSV column', () => {
    assert.deepEqual(
      [...parseTasklistNames('"Chrome.exe","1","Console","1","1 K"\r\n\r\n"brave.exe","2"')],
      ['chrome.exe', 'brave.exe']
    );
  });

  it('reads ps comm= names', () => {
    assert.deepEqual([...parsePsNames('  chrome\n/usr/lib/firefox/firefox\n\n')], ['chrome', 'firefox']);
  });
});

describe('normalizeBrowserCookieSpec', () => {
  it('accepts the yt-dlp grammar', () => {
    assert.equal(normalizeBrowserCookieSpec('chrome'), 'chrome');
    assert.equal(normalizeBrowserCookieSpec(' Edge '), 'edge');
    assert.equal(normalizeBrowserCookieSpec('chrome+GNOMEKEYRING:Profile 1'), 'chrome+gnomekeyring:Profile 1');
    assert.equal(normalizeBrowserCookieSpec('firefox:default::Personal'), 'firefox:default::Personal');
    assert.equal(normalizeBrowserCookieSpec('firefox::Personal'), 'firefox::Personal');
  });

  it('rejects unknown browsers, keyrings and control characters', () => {
    assert.equal(normalizeBrowserCookieSpec('netscape'), null);
    assert.equal(normalizeBrowserCookieSpec('--exec'), null);
    assert.equal(normalizeBrowserCookieSpec('chrome+wallet'), null);
    assert.equal(normalizeBrowserCookieSpec('chrome:a\nb'), null);
    assert.equal(normalizeBrowserCookieSpec(''), null);
    assert.equal(normalizeBrowserCookieSpec(null), null);
  });
});
