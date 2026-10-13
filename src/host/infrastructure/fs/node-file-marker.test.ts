import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Logger, LogFields } from '../../application/ports/system.ts';
import { commandFailed, commandOk, FakeCommandRunner } from '../process/fake-command-runner.ts';
import { NodeFileMarker, quarantineValue, zoneHostUrl, zoneIdentifierContent } from './node-file-marker.ts';

class RecordingLogger implements Logger {
  readonly entries: { level: string; message: string; fields: LogFields | undefined }[] = [];
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields });
  }
  child(): Logger {
    return this;
  }
}

const NOW = 1_790_000_000_123; // 2026-09-21
const NOW_HEX = Math.floor(NOW / 1000).toString(16);

describe('zone identifier content', () => {
  it('keeps scheme, host and path; drops credentials, query and fragment', () => {
    assert.equal(
      zoneHostUrl('https://user:pw@cdn.example.com/v/clip.mp4?token=abc#t=10'),
      'https://cdn.example.com/v/clip.mp4'
    );
    assert.equal(zoneHostUrl('http://example.com'), 'http://example.com/');
  });

  it('omits HostUrl for invalid or non-web URLs', () => {
    assert.equal(zoneHostUrl('not a url'), null);
    assert.equal(zoneHostUrl('file:///C:/x.mp4'), null);
    assert.equal(zoneIdentifierContent('javascript:alert(1)'), '[ZoneTransfer]\r\nZoneId=3\r\n');
  });

  it('builds the Internet-zone stream (ZoneId=3)', () => {
    assert.equal(
      zoneIdentifierContent('https://a.example/x.jpg?sig=1'),
      '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://a.example/x.jpg\r\n'
    );
  });

  it('builds the quarantine value with the unix time in hex', () => {
    assert.equal(quarantineValue(NOW), `0081;${NOW_HEX};Yami;`);
  });
});

describe('NodeFileMarker (win32 branch, injected fs)', () => {
  function make(options: { exists?: boolean; fail?: Error } = {}): {
    marker: NodeFileMarker;
    writes: [string, string][];
    logger: RecordingLogger;
    runner: FakeCommandRunner;
  } {
    const writes: [string, string][] = [];
    const logger = new RecordingLogger();
    const runner = new FakeCommandRunner();
    const marker = new NodeFileMarker({
      platform: 'win32',
      runner,
      logger,
      isRegularFile: async () => options.exists ?? true,
      writeFile: async (target, content) => {
        if (options.fail) throw options.fail;
        writes.push([target, content]);
      }
    });
    return { marker, writes, logger, runner };
  }

  it('writes <file>:Zone.Identifier with ZoneId=3 and the sanitized HostUrl', async () => {
    const { marker, writes, runner } = make();
    await marker.mark('C:\\Users\\Ana\\Downloads\\Yami\\clip.mp4', 'https://u:p@site.example/watch?v=1#t');
    assert.deepEqual(writes, [
      [
        'C:\\Users\\Ana\\Downloads\\Yami\\clip.mp4:Zone.Identifier',
        '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://site.example/watch\r\n'
      ]
    ]);
    assert.equal(runner.calls.length, 0);
  });

  it('does not create a phantom file when the target is missing', async () => {
    const { marker, writes } = make({ exists: false });
    await marker.mark('C:\\dl\\gone.mp4', 'https://x.example/');
    assert.deepEqual(writes, []);
  });

  it('refuses relative paths and names that already address a stream', async () => {
    const { marker, writes, logger } = make();
    await marker.mark('clip.mp4', 'https://x.example/');
    await marker.mark('C:\\dl\\clip.mp4:other', 'https://x.example/');
    assert.deepEqual(writes, []);
    assert.equal(logger.entries.filter((entry) => entry.level === 'warn').length, 2);
  });

  it('ignores volumes without alternate data streams (never throws)', async () => {
    const failure = Object.assign(new Error('not supported'), { code: 'EINVAL' });
    const { marker, logger } = make({ fail: failure });
    await marker.mark('E:\\usb\\clip.mp4', 'https://x.example/');
    assert.deepEqual(
      logger.entries.map((entry) => [entry.level, entry.fields?.['code']]),
      [['debug', 'EINVAL']]
    );
  });
});

describe('NodeFileMarker (real temp files)', () => {
  let dir = '';
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-marker-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it(
    'win32 branch with the default writer targets the `:Zone.Identifier` stream path',
    { skip: process.platform === 'win32' },
    async () => {
      // On a POSIX filesystem the stream path is just a sibling whose name contains ':'.
      const file = path.join(dir, 'clip.mp4');
      await writeFile(file, 'data');
      const marker = new NodeFileMarker({
        platform: 'win32',
        runner: new FakeCommandRunner(),
        logger: new RecordingLogger()
      });
      await marker.mark(file, 'https://site.example/v.mp4?x=1');
      assert.equal(
        await readFile(`${file}:Zone.Identifier`, 'utf8'),
        '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://site.example/v.mp4\r\n'
      );
      assert.equal(await readFile(file, 'utf8'), 'data', 'the file itself is untouched');
      await marker.mark(path.join(dir, 'missing.mp4'), 'https://site.example/');
      assert.deepEqual((await readdir(dir)).sort(), ['clip.mp4', 'clip.mp4:Zone.Identifier']);
    }
  );

  it(
    'macOS: runs /usr/bin/xattr -w com.apple.quarantine without a shell',
    { skip: process.platform === 'win32' },
    async () => {
      const file = path.join(dir, 'photo.jpg');
      await writeFile(file, 'x');
      const runner = new FakeCommandRunner().respond('xattr', commandOk(''));
      const marker = new NodeFileMarker({
        platform: 'darwin',
        runner,
        logger: new RecordingLogger(),
        clock: { now: () => NOW }
      });
      await marker.mark(file, 'https://site.example/p.jpg');
      assert.equal(runner.calls.length, 1);
      assert.equal(runner.calls[0]?.file, '/usr/bin/xattr');
      assert.deepEqual(runner.calls[0]?.args, ['-w', 'com.apple.quarantine', `0081;${NOW_HEX};Yami;`, file]);
    }
  );

  it(
    'macOS: skips missing files and relative paths; xattr failures are logged, not thrown',
    { skip: process.platform === 'win32' },
    async () => {
      const logger = new RecordingLogger();
      const runner = new FakeCommandRunner().respond('xattr', commandFailed('ETIMEDOUT'));
      const marker = new NodeFileMarker({ platform: 'darwin', runner, logger, clock: { now: () => NOW } });
      await marker.mark(path.join(dir, 'missing.jpg'), 'https://x.example/');
      await marker.mark('relative.jpg', 'https://x.example/');
      assert.equal(runner.calls.length, 0);
      const file = path.join(dir, 'fail.jpg');
      await writeFile(file, 'x');
      await marker.mark(file, 'https://x.example/');
      assert.equal(runner.calls.length, 1);
      assert.ok(logger.entries.some((entry) => entry.level === 'debug' && entry.fields?.['error'] === 'ETIMEDOUT'));
    }
  );

  it('Linux: no-op', async () => {
    const file = path.join(dir, 'linux.mp4');
    await writeFile(file, 'x');
    const runner = new FakeCommandRunner();
    let writes = 0;
    const marker = new NodeFileMarker({
      platform: 'linux',
      runner,
      logger: new RecordingLogger(),
      writeFile: async () => {
        writes += 1;
      }
    });
    await marker.mark(file, 'https://x.example/');
    assert.equal(runner.calls.length, 0);
    assert.equal(writes, 0);
  });
});
