import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParsedLine } from '../../../domain/engines/parsed-line.ts';
import { GalleryDlLineParser } from './gallery-dl-parser.ts';

function parse(line: string, parser = new GalleryDlLineParser()): ParsedLine {
  return parser.parse(line);
}

function detected(line: ParsedLine): { readonly status: string; readonly path: string } | null {
  return line.kind === 'file' ? { status: line.status, path: line.path } : null;
}

function errorOf(line: ParsedLine): Extract<ParsedLine, { kind: 'error' }> {
  assert.equal(line.kind, 'error');
  return line;
}

describe('GalleryDlLineParser (legacy parseOutputLine gallery-dl)', () => {
  it('detects downloaded and skipped files', () => {
    assert.deepEqual(detected(parse('* C:\\Users\\João\\Downloads\\01.jpg')), {
      status: 'downloaded',
      path: 'C:\\Users\\João\\Downloads\\01.jpg'
    });
    assert.equal(detected(parse('# C:\\Users\\João\\Downloads\\01.jpg'))?.status, 'skipped');
  });

  it('parses errors and ignores debug', () => {
    const error = errorOf(parse('[error] HttpError: 404'));
    assert.match(error.message, /404/);
    assert.equal(error.fatal, true);
    assert.equal(parse('[debug] cookies').kind, 'noise');
  });

  it('does not treat json sidecars as media', () => {
    assert.equal(detected(parse('* C:\\out\\meta.json')), null);
  });

  it('does not count .part files as downloaded', () => {
    assert.equal(detected(parse('* C:\\out\\image.jpg.part')), null);
  });

  it('maps AuthenticationError to pixiv-auth', () => {
    const error = errorOf(parse("[pixiv][error] AuthenticationError: 'refresh-token' required."));
    assert.equal(error.errorKind, 'pixiv-auth');
    assert.equal(error.message, "AuthenticationError: 'refresh-token' required.");
  });
});

describe('GalleryDlLineParser (rewrite behaviour)', () => {
  it('detects bare pipe-mode paths (the production output format)', () => {
    assert.deepEqual(detected(parse('/home/u/Yami/gallery-dl/pixiv/123_p0.png')), {
      status: 'downloaded',
      path: '/home/u/Yami/gallery-dl/pixiv/123_p0.png'
    });
    assert.deepEqual(detected(parse('D:\\Yami\\gallery-dl\\Reddit\\pics\\bob\\x 01 t.jpg')), {
      status: 'downloaded',
      path: 'D:\\Yami\\gallery-dl\\Reddit\\pics\\bob\\x 01 t.jpg'
    });
  });

  it('treats [warning] as a non-fatal log line and [error] as fatal', () => {
    assert.deepEqual(parse('[downloader.http][warning] File size smaller than allowed minimum'), {
      kind: 'info',
      level: 'warn',
      text: '[downloader.http][warning] File size smaller than allowed minimum'
    });
    assert.deepEqual(parse('[warning] deprecated option'), {
      kind: 'info',
      level: 'warn',
      text: '[warning] deprecated option'
    });
    const error = errorOf(parse('[twitter][error] 401 Unauthorized'));
    assert.equal(error.fatal, true);
    assert.equal(error.errorKind, 'login-required');
  });

  it('only reads [error] from the log prefix, not from paths (Q13)', () => {
    assert.deepEqual(detected(parse('C:\\dl\\site\\[error] title.jpg')), {
      status: 'downloaded',
      path: 'C:\\dl\\site\\[error] title.jpg'
    });
    assert.equal(parse('/dl/site/[warning]/a.jpg').kind, 'file');
  });

  it('classifies errors with the category of the log line', () => {
    assert.equal(
      errorOf(parse("[gallery-dl][error] Unsupported URL 'https://example.com/'")).errorKind,
      'unsupported-url'
    );
    assert.equal(errorOf(parse("[kemonoparty][error] HttpError: '429 Too Many Requests'")).errorKind, 'rate-limited');
    assert.equal(
      errorOf(parse('[twitter][error] AuthenticationError: Invalid username or password')).errorKind,
      'login-required'
    );
  });

  it('never classifies another site echoing the YouTube bot check as cookies-auth', () => {
    const error = errorOf(parse("[kemonoparty][error] HttpError: '403 Sign in to confirm you're not a bot'"));
    assert.notEqual(error.errorKind, 'cookies-auth');
    assert.notEqual(errorOf(parse('[error] [generic] HTTP Error 403: not a bot')).errorKind, 'cookies-auth');
  });

  it('keeps info lines visible and strips ANSI', () => {
    assert.deepEqual(parse('\u001b[1;33m[pixiv][info]\u001b[0m Waiting until 12:00:00 (rate limit)'), {
      kind: 'info',
      level: 'info',
      text: '[pixiv][info] Waiting until 12:00:00 (rate limit)'
    });
  });

  it('filters transient and json skips', () => {
    assert.equal(parse('# /dl/a.jpg.part').kind, 'noise');
    assert.deepEqual(detected(parse('# /dl/a.jpg')), { status: 'skipped', path: '/dl/a.jpg' });
  });

  it('accepts UNC paths only on a UNC destination and, there, extension-less files (Q15)', () => {
    const parser = new GalleryDlLineParser({ downloadDir: '\\\\nas\\share\\gallery-dl' });
    assert.equal(detected(parser.parse('\\\\nas\\share\\gallery-dl\\site\\01.jpg'))?.status, 'downloaded');
    assert.deepEqual(detected(parser.parse('\\\\NAS\\share\\gallery-dl\\site\\README')), {
      status: 'downloaded',
      path: '\\\\NAS\\share\\gallery-dl\\site\\README'
    });
    assert.equal(parse('\\\\nas\\share\\gallery-dl\\site\\README').kind, 'info');
  });

  it('normalizes decomposed Unicode paths to NFC', () => {
    const parsed = detected(parse('/dl/Vi\u0301deo.mp4'));
    assert.equal(parsed?.path, '/dl/Vídeo.mp4');
  });
});

// Security: a crafted title with a newline can forge a whole output line; the core stats
// every reported path, and stat-ing \\host\share makes Windows send an NTLM hash there.
describe('GalleryDlLineParser (forged output paths)', () => {
  const winParser = (): GalleryDlLineParser => new GalleryDlLineParser({ downloadDir: 'D:\\Yami\\gallery-dl' });

  it('never reports UNC paths without a UNC destination', () => {
    for (const line of [
      '\\\\evil\\share\\x.jpg',
      '* \\\\evil\\share\\x.jpg',
      '# \\\\evil\\share\\x.jpg',
      '//evil/share/x.jpg'
    ]) {
      assert.equal(parse(line).kind, 'info', line);
      assert.equal(winParser().parse(line).kind, 'info', line);
    }
    const onShare = new GalleryDlLineParser({ downloadDir: '\\\\nas\\share\\gallery-dl' });
    assert.equal(onShare.parse('\\\\evil\\share\\gallery-dl\\x.jpg').kind, 'info');
  });

  it('with a known destination reports only paths inside it', () => {
    const parser = winParser();
    assert.deepEqual(detected(parser.parse('D:\\Yami\\gallery-dl\\pixiv\\1_p0.png')), {
      status: 'downloaded',
      path: 'D:\\Yami\\gallery-dl\\pixiv\\1_p0.png'
    });
    assert.equal(parser.parse('C:\\Windows\\System32\\x.dll').kind, 'info');
    assert.equal(parser.parse('* C:\\elsewhere\\x.jpg').kind, 'info');
    assert.equal(parser.parse('# D:\\Yami\\gallery-dl\\..\\..\\x.jpg').kind, 'info');
    assert.equal(detected(parser.parse('# D:\\Yami\\gallery-dl\\site\\x.jpg'))?.status, 'skipped');
    const posix = new GalleryDlLineParser({ downloadDir: '/home/u/Yami/gallery-dl' });
    assert.equal(posix.parse('/etc/ssl/private/key.pem').kind, 'info');
    assert.equal(posix.parse('/home/u/Yami/gallery-dl/../../.ssh/id.png').kind, 'info');
    assert.equal(detected(posix.parse('./gallery-dl/site/01.png'))?.status, 'downloaded');
  });
});
