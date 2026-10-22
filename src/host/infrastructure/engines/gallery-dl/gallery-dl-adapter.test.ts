import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvocationContext } from '../../../application/ports/engines.ts';
import { GALLERY_DL_SECRET_CONFIG_FILE, GalleryDlAdapter } from './gallery-dl-adapter.ts';
import { GALLERY_DL_CACHE_FILE } from './gallery-dl-args.ts';

function context(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    url: 'https://example.com/a',
    downloadDir: 'D:\\Downloads\\gallery-dl',
    tempDir: 'D:\\Work\\d1\\tmp',
    executable: { path: 'C:\\Yami\\bin\\gallery-dl.exe', prefixArgs: [] },
    ffmpegPath: null,
    denoPath: null,
    cookieFile: null,
    browserCookies: null,
    secretConfigFile: null,
    platform: 'win32',
    ...overrides
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === '-o' ? [arg] : []));
}

describe('GalleryDlAdapter.buildInvocation (legacy buildArgs)', () => {
  it('passes URL last and never uses a shell string', () => {
    const args = new GalleryDlAdapter({ delegateVideosToYtdl: () => true }).buildInvocation(
      context({ cookieFile: 'C:\\Users\\PC\\AppData\\Roaming\\Yami\\data\\work\\d1\\site.txt' })
    ).args;
    assert.equal(args[args.length - 1], 'https://example.com/a');
    assert.ok(args.includes('--windows-filenames'));
    assert.ok(args.includes('--cookies'));
    assert.ok(options(args).includes('extractor.cookies-update=false'));
  });

  it('passes the pixiv refresh-token when provided — now through a private config file', () => {
    const adapter = new GalleryDlAdapter();
    const creds = new Map([
      [
        'pixiv',
        { kind: 'refresh-token' as const, refreshToken: 'secret-token', userName: null, userId: null, savedAt: 1 }
      ]
    ]);
    const secret = adapter.secretConfig('https://www.pixiv.net/artworks/1', { siteCredentials: creds });
    assert.ok(secret);
    assert.equal(secret.fileName, GALLERY_DL_SECRET_CONFIG_FILE);
    const parsed: unknown = JSON.parse(secret.content);
    assert.deepEqual(parsed, {
      extractor: { pixiv: { 'refresh-token': 'secret-token' }, 'pixiv-novel': { 'refresh-token': 'secret-token' } }
    });
  });

  it('omits the pixiv refresh-token when empty', () => {
    const adapter = new GalleryDlAdapter();
    const empty = { siteCredentials: new Map() };
    assert.equal(adapter.secretConfig('https://www.pixiv.net/artworks/1', empty), null);
  });

  it('passes gelbooru api-key and user-id through the secret config', () => {
    const adapter = new GalleryDlAdapter();
    const creds = new Map([
      [
        'gelbooru',
        {
          kind: 'api-key' as const,
          apiKey: 'secret-api-key',
          userName: null,
          userId: '2065192',
          savedAt: 1
        }
      ]
    ]);
    const secret = adapter.secretConfig('https://gelbooru.com/index.php?page=post&s=view&id=1', {
      siteCredentials: creds
    });
    assert.ok(secret);
    assert.deepEqual(JSON.parse(secret.content), {
      extractor: { gelbooru: { 'api-key': 'secret-api-key', 'user-id': '2065192' } }
    });
  });
});

describe('GalleryDlAdapter (fixed quirks)', () => {
  it('never puts the token on argv and loads the secret config right after --config-ignore (Q22)', () => {
    const adapter = new GalleryDlAdapter();
    const url = 'https://www.pixiv.net/artworks/1';
    const creds = new Map([
      [
        'pixiv',
        { kind: 'refresh-token' as const, refreshToken: 'secret-token', userName: null, userId: null, savedAt: 1 }
      ]
    ]);
    assert.ok(adapter.secretConfig(url, { siteCredentials: creds }));
    const args = adapter.buildInvocation(
      context({ url, secretConfigFile: 'D:\\Work\\d1\\gallery-dl-secrets.json' })
    ).args;
    assert.deepEqual(args.slice(0, 3), ['--config-ignore', '-c', 'D:\\Work\\d1\\gallery-dl-secrets.json']);
    assert.equal(
      args.some((arg) => arg.includes('secret-token') || /refresh-token/i.test(arg)),
      false
    );
    assert.equal(args.filter((arg) => arg === '-c').length, 1);
  });

  it('adds no -c when there is no secret config', () => {
    const args = new GalleryDlAdapter().buildInvocation(context()).args;
    assert.equal(args.includes('-c'), false);
    assert.equal(args[0], '--config-ignore');
  });

  it('only creates secret configs for Pixiv App URLs', () => {
    const adapter = new GalleryDlAdapter();
    const secrets = {
      siteCredentials: new Map([
        ['pixiv', { kind: 'refresh-token' as const, refreshToken: 'tok', userName: null, userId: null, savedAt: 1 }]
      ])
    };
    assert.ok(adapter.secretConfig('https://pixiv.net/users/1', secrets));
    assert.ok(adapter.secretConfig('https://www.pixiv.net/novel/show.php?id=1', secrets));
    assert.equal(adapter.secretConfig('https://sketch.pixiv.net/@a', secrets), null);
    assert.equal(adapter.secretConfig('https://x.com/a', secrets), null);
  });

  it('prefixes every extractor option with extractor. (Q6)', () => {
    const opts = options(new GalleryDlAdapter({ delegateVideosToYtdl: () => true }).buildInvocation(context()).args);
    for (const option of opts) {
      assert.match(option, /^(?:extractor|output|cache)\./, option);
    }
    for (const expected of [
      'extractor.skip=true',
      'extractor.deviantart.original=true',
      'extractor.deviantart.quality=png',
      'extractor.pixiv.ugoira=original',
      'extractor.danbooru.ugoira=true',
      'extractor.reddit.videos=dash',
      'extractor.fanbox.embeds=ytdl',
      'extractor.facebook.videos=ytdl',
      'extractor.reddit.api=rest',
      `extractor.reddit.user-agent=Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)`,
      'extractor.reddit.filename={id} {num:>02} {title}.{extension}',
      'extractor.reddit.user.directory=["Reddit","{user[name]}"]'
    ]) {
      assert.ok(opts.includes(expected), expected);
    }
  });

  it('delegates videos to ytdl only when allowed (Q7)', () => {
    const opts = options(new GalleryDlAdapter().buildInvocation(context()).args);
    assert.equal(
      opts.some((option) => option.endsWith('=ytdl')),
      false
    );
    // Reddit does not ride this gate: its `dash` manifest is pinned unconditionally, since
    // the gate keys on the yt-dlp executable and `dash` is already gallery-dl's default.
    assert.ok(opts.includes('extractor.reddit.videos=dash'));
  });

  it('sends a feed-reader User-Agent to Reddit only', () => {
    const opts = options(new GalleryDlAdapter().buildInvocation(context()).args);
    // Pinned literally, not via the constant: the exact string is the contract with Reddit.
    assert.deepEqual(
      opts.filter((option) => option.includes('.user-agent=')),
      ['extractor.reddit.user-agent=Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)']
    );
  });

  it('forces UTF-8 output via options and environment (Q3)', () => {
    const invocation = new GalleryDlAdapter().buildInvocation(context());
    const opts = options(invocation.args);
    assert.ok(opts.includes('output.stdout=utf-8'));
    assert.ok(opts.includes('output.stderr=utf-8'));
    assert.ok(opts.includes('output.mode=pipe'));
    assert.equal(invocation.env['PYTHONUTF8'], '1');
    assert.equal(invocation.env['PYTHONIOENCODING'], 'utf-8');
  });

  it('puts -- right before the URL and passes the destination explicitly (Q2)', () => {
    const args = new GalleryDlAdapter().buildInvocation(context({ url: 'https://example.com/-o' })).args;
    assert.deepEqual(args.slice(-2), ['--', 'https://example.com/-o']);
    assert.equal(valueAfter(args, '--destination'), 'D:\\Downloads\\gallery-dl');
  });

  it('never adds user-controllable execution flags', () => {
    const args = new GalleryDlAdapter().buildInvocation(context({ cookieFile: '/w/c.txt' })).args;
    for (const flag of ['--exec', '--exec-after', '--config', '--config-yaml', '--config-toml', '-i', '--input-file']) {
      assert.equal(args.includes(flag), false, flag);
    }
    assert.equal(
      options(args).some((option) => /exec|postprocessors/i.test(option)),
      false
    );
  });

  it('prepends the python module prefix and does not support browser cookies', () => {
    const adapter = new GalleryDlAdapter();
    const invocation = adapter.buildInvocation(
      context({ executable: { path: 'python', prefixArgs: ['-m', 'gallery_dl'] } })
    );
    assert.deepEqual(invocation.args.slice(0, 3), ['-m', 'gallery_dl', '--config-ignore']);
    assert.equal(adapter.supportsBrowserCookies(), false);
    assert.equal(adapter.slotWeight, 1);
  });
});

// Security: gallery-dl caches login sessions, cookies and OAuth access tokens (e.g. the
// Pixiv access token derived from our vaulted refresh token) in a persistent SQLite file.
describe('GalleryDlAdapter cache database', () => {
  function cacheOption(args: readonly string[]): string | undefined {
    return options(args).find((option) => option.startsWith('cache.file='));
  }

  function cacheValue(args: readonly string[]): unknown {
    const option = cacheOption(args);
    assert.ok(option, 'cache.file must always be set');
    // gallery-dl parses `-o` values as JSON first: decode the same way.
    return JSON.parse(option.slice('cache.file='.length));
  }

  it('keeps the cache in the private per-run secrets dir (Windows)', () => {
    const args = new GalleryDlAdapter().buildInvocation(context({ secretDir: 'D:\\Work\\d1' })).args;
    assert.equal(cacheValue(args), `D:\\Work\\d1\\${GALLERY_DL_CACHE_FILE}`);
    // Backslashes are JSON-escaped on argv so the JSON decoding restores them.
    assert.equal(cacheOption(args), 'cache.file="D:\\\\Work\\\\d1\\\\gallery-dl-cache.sqlite3"');
  });

  it('keeps the cache in the private per-run secrets dir (POSIX)', () => {
    const args = new GalleryDlAdapter().buildInvocation(
      context({ secretDir: '/home/u/.config/Yami/work/d1', platform: 'linux' })
    ).args;
    assert.equal(cacheValue(args), `/home/u/.config/Yami/work/d1/${GALLERY_DL_CACHE_FILE}`);
  });

  it('never puts the cache in the temp dir, which survives a pause for resumable downloads', () => {
    const args = new GalleryDlAdapter().buildInvocation(
      context({ tempDir: 'D:\\Work\\d1\\tmp', secretDir: 'D:\\Work\\d1' })
    ).args;
    assert.ok(!String(cacheValue(args)).includes('tmp'), String(cacheValue(args)));
  });

  it('round-trips quotes and non-ASCII characters through the JSON value', () => {
    const secretDir = '/home/João/Yami "x"/work/d1';
    const args = new GalleryDlAdapter().buildInvocation(context({ secretDir, platform: 'linux' })).args;
    assert.equal(cacheValue(args), `${secretDir}/${GALLERY_DL_CACHE_FILE}`);
  });

  it('disables the database cache (null, in memory only) when there is no secrets dir', () => {
    for (const secretDir of [undefined, null, '']) {
      const args = new GalleryDlAdapter().buildInvocation(context({ secretDir })).args;
      assert.equal(cacheValue(args), null, String(secretDir));
    }
  });

  it('sets the cache before the URL separator', () => {
    const args = new GalleryDlAdapter().buildInvocation(context({ secretDir: 'D:\\Work\\d1' })).args;
    const option = cacheOption(args);
    assert.ok(option);
    assert.ok(args.indexOf(option) < args.indexOf('--'));
  });
});
