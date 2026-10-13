import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParsedLine } from '../../../domain/engines/parsed-line.ts';
import { YtDlpLineParser } from './yt-dlp-parser.ts';

function parse(line: string, parser = new YtDlpLineParser()): ParsedLine {
  return parser.parse(line);
}

function pendingPath(line: ParsedLine): string | undefined {
  return line.kind === 'pending-file' ? line.path : undefined;
}

function detected(line: ParsedLine): { readonly status: string; readonly path: string } | null {
  return line.kind === 'file' ? { status: line.status, path: line.path } : null;
}

function progressOf(line: ParsedLine): Extract<ParsedLine, { kind: 'progress' }> {
  assert.equal(line.kind, 'progress');
  return line;
}

function errorOf(line: ParsedLine): Extract<ParsedLine, { kind: 'error' }> {
  assert.equal(line.kind, 'error');
  return line;
}

describe('YtDlpLineParser (legacy parseOutputLine yt-dlp)', () => {
  it('ignores blank, debug and unexpected lines', () => {
    assert.equal(parse('').kind, 'noise');
    assert.equal(parse('[debug] ffmpeg').kind, 'noise');
    assert.deepEqual(parse('some random extractor chatter'), {
      kind: 'info',
      level: 'info',
      text: 'some random extractor chatter'
    });
  });

  it('parses progress with speed and ETA', () => {
    const parsed = progressOf(parse('[download]  42.5% of  12.00MiB at  1.20MiB/s ETA 00:08'));
    assert.equal(parsed.percent, 42.5);
    assert.equal(parsed.speed, '1.20MiB/s');
    assert.equal(parsed.eta, '00:08');
  });

  it('stores destination without counting it as done', () => {
    const parsed = parse('[download] Destination: C:\\Users\\João\\Downloads\\Yami\\yt-dlp\\site\\video [id].mp4');
    assert.equal(parsed.kind, 'pending-file');
    assert.match(pendingPath(parsed) ?? '', /video \[id\]\.mp4$/);
  });

  it('strips quotes from destination', () => {
    assert.equal(
      pendingPath(parse('[download] Destination: "D:\\Mídia\\Vídeos\\clip.webm"')),
      'D:\\Mídia\\Vídeos\\clip.webm'
    );
  });

  it('does not pending fragment destinations', () => {
    assert.equal(parse('[download] Destination: C:\\Temp\\yami-ytdlp\\video.f137.mp4').kind, 'noise');
  });

  it('does not pending .part or .ytdl destinations', () => {
    assert.equal(parse('[download] Destination: C:\\Downloads\\video.mp4.part').kind, 'noise');
    assert.equal(parse('[download] Destination: C:\\Downloads\\video.mp4.ytdl').kind, 'noise');
  });

  // Q16: thumbnails are recognised by the thumbnail writer message, not by extension.
  it('ignores sidecar thumbnails and quoted unknown chatter', () => {
    const parser = new YtDlpLineParser();
    assert.equal(parser.parse('[info] Writing video thumbnail 0 to: C:\\Downloads\\folder\\image.jpg').kind, 'info');
    assert.equal(
      parser.parse('[MoveFiles] Moving file "C:\\Downloads\\folder\\image.jpg" to "D:\\Yami\\folder\\image.jpg"').kind,
      'noise'
    );
    const random = parse('Destination: C:\\Downloads\\video.mp4');
    assert.equal(random.kind, 'info');
    assert.equal(parse('100%').kind, 'info');
    assert.equal(parse('Destination: error.png').kind, 'info');
  });

  it('treats MoveFiles destination as the completed file', () => {
    const parsed = parse(
      '[MoveFiles] Moving file "C:\\Users\\PC\\AppData\\Local\\Temp\\yami-ytdlp\\generic\\clip [id].mp4" to "C:\\Users\\João\\Downloads\\Yami\\yt-dlp\\generic\\clip [id].mp4"'
    );
    assert.deepEqual(detected(parsed), {
      status: 'downloaded',
      path: 'C:\\Users\\João\\Downloads\\Yami\\yt-dlp\\generic\\clip [id].mp4'
    });
  });

  it('treats Merger after 100% as a single completed file when paths match', () => {
    const parser = new YtDlpLineParser();
    assert.match(pendingPath(parser.parse('[download] Destination: C:\\Downloads\\final.mp4')) ?? '', /final\.mp4$/);
    assert.equal(parser.parse('[download] 100% of 5.00MiB').kind, 'promote-pending');
    assert.deepEqual(detected(parser.parse('[Merger] Merging formats into "C:\\Downloads\\final.mp4"')), {
      status: 'downloaded',
      path: 'C:\\Downloads\\final.mp4'
    });
  });

  it('ignores WARNING, DEBUG and youtube extractor lines', () => {
    assert.deepEqual(parse('WARNING: ffmpeg not found'), {
      kind: 'info',
      level: 'warn',
      text: 'WARNING: ffmpeg not found'
    });
    assert.equal(parse('[debug] ffmpeg').kind, 'noise');
    assert.equal(parse('[youtube] abc: Downloading webpage').kind, 'info');
  });

  it('handles unicode, quotes, spaces and playlist counters', () => {
    assert.equal(
      pendingPath(parse('[download] Destination: "D:\\Mídia longa\\Vídeos do João\\clip.webm"')),
      'D:\\Mídia longa\\Vídeos do João\\clip.webm'
    );
    assert.equal(parse('[download] Downloading item 2 of 10').kind, 'noise');
    assert.equal(parse('ERROR: unable to download video data').kind, 'error');
  });

  it('promotes pending destination at 100%', () => {
    const parser = new YtDlpLineParser();
    parser.parse('[download] Destination: /home/u/Yami/yt-dlp/site/a.mp4');
    assert.deepEqual(parser.parse('[download] 100% of 5.00MiB'), {
      kind: 'promote-pending',
      text: '[download] 100% of 5.00MiB'
    });
    // Without a pending destination the same line is plain progress.
    assert.equal(progressOf(parse('[download] 100% of 5.00MiB')).percent, 100);
  });

  it('detects merger output as downloaded', () => {
    const parsed = parse('[Merger] Merging formats into "C:\\Users\\User\\OneDrive\\Downloads\\final.mp4"');
    assert.deepEqual(detected(parsed), {
      status: 'downloaded',
      path: 'C:\\Users\\User\\OneDrive\\Downloads\\final.mp4'
    });
  });

  it('treats already-downloaded as skipped', () => {
    assert.deepEqual(detected(parse('[download] C:\\out\\a.mp4 has already been downloaded')), {
      status: 'skipped',
      path: 'C:\\out\\a.mp4'
    });
  });

  it('parses ERROR and WARNING without throwing', () => {
    const privateVideo = errorOf(parse('ERROR: [youtube] abc: Private video'));
    assert.equal(privateVideo.message, '[youtube] abc: Private video');
    assert.equal(privateVideo.fatal, true);
    const bot = errorOf(
      parse(
        'ERROR: [youtube] FiOBHYPKyjs: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser or --cookies for the authentication.'
      )
    );
    assert.equal(bot.errorKind, 'cookies-auth');
    // Messages stay raw engine text; the UI translates the kind (Q12).
    assert.match(bot.message, /not a bot/);
    const cookieCopy = errorOf(
      parse(
        'ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info'
      )
    );
    assert.equal(cookieCopy.errorKind, 'cookie-copy');
    const warn = parse('WARNING: ffmpeg not found');
    assert.equal(warn.kind, 'info');
    assert.equal(warn.kind === 'info' ? warn.level : null, 'warn');
  });

  it('ignores playlist item counters', () => {
    assert.equal(parse('[download] Downloading item 3 of 12').kind, 'noise');
  });

  // Legacy progressFingerprint test: the fingerprint lives in the downloads core; the
  // parser must report distinct values for it.
  it('reports distinct progress values for the progress fingerprint', () => {
    const a = progressOf(parse('[download]  10.2% of 1MiB at 1x ETA 1:00'));
    const b = progressOf(parse('[download]  11.9% of 1MiB at 1x ETA 1:00'));
    assert.notEqual(a.percent, b.percent);
  });
});

describe('YtDlpLineParser (rewrite behaviour)', () => {
  // Security: cookies-auth may start a browser-cookie retry; other sites can echo YouTube's wording.
  it('classifies the bot-check wording as cookies-auth only for YouTube extractors', () => {
    assert.notEqual(
      errorOf(parse('ERROR: [generic] x: Unable to download webpage: HTTP Error 403: not a bot')).errorKind,
      'cookies-auth'
    );
    assert.notEqual(
      errorOf(parse('ERROR: unable to download video data: HTTP Error 403: Sign in to confirm you\u2019re not a bot'))
        .errorKind,
      'cookies-auth'
    );
    assert.equal(
      errorOf(parse('ERROR: [youtube:tab] PL1: Sign in to confirm you\u2019re not a bot')).errorKind,
      'cookies-auth'
    );
  });

  it('strips ANSI colours before classifying errors', () => {
    const parsed = errorOf(parse('\u001b[0;31mERROR:\u001b[0m [youtube] x: Video unavailable'));
    assert.equal(parsed.message, '[youtube] x: Video unavailable');
    assert.equal(parsed.text, 'ERROR: [youtube] x: Video unavailable');
  });

  it('handles CR-only progress redraws', () => {
    assert.equal(progressOf(parse('[download]   5.0% of 1MiB\r[download]  55.0% of 1MiB')).percent, 55);
  });

  it('parses the machine-readable progress template', () => {
    const running = progressOf(parse('[yami-progress] downloading|  42.5%|  1.20MiB/s|00:08'));
    assert.deepEqual(running, { kind: 'progress', percent: 42.5, speed: '1.20MiB/s', eta: '00:08' });
    const unknown = progressOf(parse('[yami-progress] downloading|  N/A%| Unknown B/s|Unknown'));
    assert.deepEqual(unknown, { kind: 'progress', percent: null, speed: null, eta: null });
    const finished = progressOf(parse('[yami-progress] finished|100.0%|  2.00MiB/s|NA'));
    assert.equal(finished.percent, 100);
  });

  it('reports unknown speed/ETA as null instead of stale text', () => {
    const parsed = progressOf(parse('[download]  12.0% of ~ 50.00MiB at Unknown B/s ETA Unknown (frag 5/50)'));
    assert.equal(parsed.speed, null);
    assert.equal(parsed.eta, null);
  });

  it('never reports temp-dir outputs as final when the temp dir is known', () => {
    const parser = new YtDlpLineParser({ tempDir: 'C:\\Users\\U\\AppData\\Local\\Yami\\work\\job1\\tmp' });
    const temp = 'C:\\Users\\U\\AppData\\Local\\Yami\\work\\job1\\tmp\\youtube\\Up\\Title [x1]';
    assert.equal(parser.parse(`[info] Writing video thumbnail 0 to: ${temp}.webp`).kind, 'info');
    assert.equal(parser.parse(`[download] Destination: ${temp}.f399.mp4`).kind, 'noise');
    assert.equal(progressOf(parser.parse('[yami-progress] finished|100.0%|1MiB/s|NA')).percent, 100);
    assert.equal(parser.parse(`[download] Destination: ${temp}.f251.webm`).kind, 'noise');
    assert.equal(pendingPath(parser.parse(`[Merger] Merging formats into "${temp}.webm"`)), `${temp}.webm`);
    // Pending is inside the temp dir: completion is plain progress, never a promotion.
    assert.equal(parser.parse('[download] 100% of 5.00MiB').kind, 'progress');
    assert.equal(parser.parse(`[Metadata] Adding metadata to "${temp}.webm"`).kind, 'info');
    assert.equal(
      parser.parse(`[MoveFiles] Moving file "${temp}.webp" to "D:\\Yami\\yt-dlp\\youtube\\Up\\Title [x1].webp"`).kind,
      'noise'
    );
    assert.deepEqual(
      detected(
        parser.parse(`[MoveFiles] Moving file "${temp}.webm" to "D:\\Yami\\yt-dlp\\youtube\\Up\\Title [x1].webm"`)
      ),
      {
        status: 'downloaded',
        path: 'D:\\Yami\\yt-dlp\\youtube\\Up\\Title [x1].webm'
      }
    );
  });

  it('follows remux/convert outputs as the pending destination', () => {
    const parser = new YtDlpLineParser({ tempDir: '/tmp/job' });
    parser.parse('[Merger] Merging formats into "/tmp/job/site/u/t [1].mkv"');
    assert.equal(
      pendingPath(
        parser.parse('[VideoRemuxer] Remuxing video from mkv to mp4; Destination: /tmp/job/site/u/t [1].mp4')
      ),
      '/tmp/job/site/u/t [1].mp4'
    );
  });

  it('recognises a thumbnail by its media stem when the writer line is missing', () => {
    const parser = new YtDlpLineParser();
    parser.parse('[info] Video thumbnail is already present');
    parser.parse('[download] Destination: /tmp/t/site/u/clip [7].f137.mp4');
    parser.parse('[Merger] Merging formats into "/tmp/t/site/u/clip [7].mp4"');
    assert.equal(
      parser.parse('[MoveFiles] Moving file "/tmp/t/site/u/clip [7].jpg" to "/d/site/u/clip [7].jpg"').kind,
      'noise'
    );
  });

  it('counts image media downloaded by yt-dlp (Q16)', () => {
    const parser = new YtDlpLineParser({ tempDir: '/tmp/job' });
    assert.equal(
      pendingPath(parser.parse('[download] Destination: /tmp/job/site/u/photo [9].jpg')),
      '/tmp/job/site/u/photo [9].jpg'
    );
    assert.deepEqual(
      detected(parser.parse('[MoveFiles] Moving file "/tmp/job/site/u/photo [9].jpg" to "/d/site/u/photo [9].jpg"')),
      {
        status: 'downloaded',
        path: '/d/site/u/photo [9].jpg'
      }
    );
  });

  it('keeps relative and POSIX paths exactly as printed', () => {
    assert.equal(pendingPath(parse('[download] Destination: site/u/a [1].mp4')), 'site/u/a [1].mp4');
    assert.deepEqual(detected(parse('[download] /home/u/Yami/a [1].mp4 has already been downloaded')), {
      status: 'skipped',
      path: '/home/u/Yami/a [1].mp4'
    });
  });

  it('never promotes the same pending destination twice', () => {
    const parser = new YtDlpLineParser();
    parser.parse('[download] Destination: /d/a.mp4');
    assert.equal(parser.parse('[download] 100% of 1MiB').kind, 'promote-pending');
    assert.equal(parser.parse('[yami-progress] finished|100.0%|1MiB/s|NA').kind, 'progress');
  });

  it('keeps metadata sidecars out of the file list', () => {
    assert.equal(parse('[MoveFiles] Moving file "/t/a.info.json" to "/d/a.info.json"').kind, 'noise');
    assert.equal(parse('[MoveFiles] Moving file "/t/a.en.vtt" to "/d/a.en.vtt"').kind, 'noise');
  });
});

// Security: a crafted title with a newline can forge a whole output line; the core stats
// every reported path, and stat-ing \\host\share makes Windows send an NTLM hash there.
describe('YtDlpLineParser (forged output paths)', () => {
  const home = 'D:\\Yami\\yt-dlp';
  const temp = 'C:\\Users\\U\\AppData\\Roaming\\Yami\\work\\j1\\tmp';
  const winParser = (): YtDlpLineParser => new YtDlpLineParser({ downloadDir: home, tempDir: temp });

  const forged = [
    '[Merger] Merging formats into "\\\\evil\\share\\x.mp4"',
    '[download] Destination: \\\\evil\\share\\x.mp4',
    '[MoveFiles] Moving file "C:\\t\\x.mp4" to "\\\\evil\\share\\x.mp4"',
    '[download] \\\\evil\\share\\x.mp4 has already been downloaded',
    '[VideoRemuxer] Remuxing video from mkv to mp4; Destination: \\\\evil\\share\\x.mp4',
    '[ExtractAudio] Destination: //evil/share/x.m4a',
    '[Merger] Merging formats into "\\\\?\\UNC\\evil\\share\\x.mp4"'
  ];

  it('never reports UNC paths, with or without a known download dir', () => {
    for (const line of forged) {
      const withDir = winParser().parse(line);
      assert.equal(withDir.kind, 'info', line);
      const withoutDir = new YtDlpLineParser().parse(line);
      assert.equal(withoutDir.kind, 'info', line);
    }
  });

  it('with a known download dir reports only paths inside it (or pending inside the temp dir)', () => {
    const parser = winParser();
    assert.equal(parser.parse('[Merger] Merging formats into "C:\\Windows\\x.mp4"').kind, 'info');
    assert.equal(parser.parse('[download] Destination: E:\\x.mp4').kind, 'info');
    assert.equal(parser.parse(`[Merger] Merging formats into "${home}\\..\\..\\x.mp4"`).kind, 'info');
    assert.equal(
      pendingPath(parser.parse(`[download] Destination: ${home}\\site\\a [1].mp4`)),
      `${home}\\site\\a [1].mp4`
    );
    assert.equal(
      pendingPath(parser.parse(`[Merger] Merging formats into "${temp}\\site\\a [1].mp4"`)),
      `${temp}\\site\\a [1].mp4`
    );
    assert.deepEqual(
      detected(parser.parse(`[MoveFiles] Moving file "${temp}\\site\\a [1].mp4" to "${home}\\site\\a [1].mp4"`)),
      {
        status: 'downloaded',
        path: `${home}\\site\\a [1].mp4`
      }
    );
    assert.equal(pendingPath(parser.parse('[download] Destination: site/u/b [2].mp4')), 'site/u/b [2].mp4');
  });

  it('a rejected destination is never promoted', () => {
    const parser = winParser();
    assert.equal(parser.parse('[download] Destination: \\\\evil\\share\\x.mp4').kind, 'info');
    assert.equal(parser.parse('[download] 100% of 1MiB').kind, 'progress');
  });

  it('accepts a download dir on a share for that share only', () => {
    const parser = new YtDlpLineParser({ downloadDir: '\\\\nas\\media\\yt-dlp' });
    assert.equal(
      detected(parser.parse('[Merger] Merging formats into "\\\\nas\\media\\yt-dlp\\s\\a.mp4"'))?.status,
      'downloaded'
    );
    assert.equal(parser.parse('[Merger] Merging formats into "\\\\evil\\media\\yt-dlp\\s\\a.mp4"').kind, 'info');
  });

  it('treats an already-downloaded temp copy as pending, not as a skipped final file', () => {
    const parser = winParser();
    assert.equal(
      pendingPath(parser.parse(`[download] ${temp}\\site\\c [3].mp4 has already been downloaded`)),
      `${temp}\\site\\c [3].mp4`
    );
    assert.deepEqual(detected(parser.parse(`[download] ${home}\\site\\c [3].mp4 has already been downloaded`)), {
      status: 'skipped',
      path: `${home}\\site\\c [3].mp4`
    });
  });
});
