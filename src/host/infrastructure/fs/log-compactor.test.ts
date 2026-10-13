import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeLogReader } from './node-log-reader.ts';
import { compactLog, DEFAULT_LOG_COMPACTION, isCompactionTempFile } from './log-compactor.ts';

const MARKER = /^\[yami\] \.\.\. (\d+) bytes of engine output omitted \(log compacted\) \.\.\.$/;

describe('compactLog', () => {
  let dir = '';
  let file = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-logc-'));
    file = path.join(dir, 'job.log');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('recognizes only its own temp file names as leftovers', async () => {
    assert.equal(isCompactionTempFile('.job1.log.0123456789ab.tmp'), true);
    for (const name of [
      'job1.log',
      '.job1.log.tmp',
      '.job1.log.0123456789AB.tmp',
      '.cookies.txt.0123456789ab.tmp',
      '.a.log.0123.tmp'
    ]) {
      assert.equal(isCompactionTempFile(name), false, name);
    }
  });

  it('leaves a log within the bounds untouched and reports a missing one', async () => {
    await writeFile(file, 'a'.repeat(20));
    assert.equal(await compactLog(file, { headBytes: 10, tailBytes: 10 }), 'unchanged');
    assert.equal(await readFile(file, 'utf8'), 'a'.repeat(20));
    assert.equal(await compactLog(path.join(dir, 'nope.log')), 'missing');
  });

  it('keeps whole lines around the marker and accounts for every omitted byte', async () => {
    // yt-dlp progress uses `\n` with --newline; `\r\n` on Windows; a lone `\r` when redrawn.
    const text = `first\r\nsecond\nthird-line-cut${'x'.repeat(200)}\rtail-cut\r\nlast one\n`;
    await writeFile(file, text);
    assert.equal(await compactLog(file, { headBytes: 17, tailBytes: 20 }), 'compacted');
    const result = await readFile(file, 'utf8');
    const head = 'first\r\nsecond\n';
    // A lone `\r` ends a line too: `tail-cut` is complete.
    const tail = 'tail-cut\r\nlast one\n';
    assert.ok(result.startsWith(head), JSON.stringify(result));
    assert.ok(result.endsWith(`\n${tail}`), JSON.stringify(result));
    const markerLine = result.slice(head.length, result.length - tail.length - 1);
    const omitted = Number(MARKER.exec(markerLine)?.[1]);
    assert.equal(omitted, Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail));
    assert.deepEqual(await readdir(dir), ['job.log'], 'no temp leftovers');
  });

  it('keeps an edge line that ends or starts exactly at the window boundary', async () => {
    await writeFile(file, 'aaaa\nbbbb\ncccc\ndddd\n');
    assert.equal(await compactLog(file, { headBytes: 4, tailBytes: 10 }), 'compacted');
    const lines = (await readFile(file, 'utf8')).split('\n');
    assert.equal(lines[0], 'aaaa');
    assert.match(lines[1] ?? '', MARKER);
    assert.deepEqual(lines.slice(2), ['cccc', 'dddd', '']);
  });

  it('keeps raw bytes when the head or tail holds no line terminator', async () => {
    await writeFile(file, `${'h'.repeat(30)}${'t'.repeat(30)}`);
    assert.equal(await compactLog(file, { headBytes: 5, tailBytes: 5 }), 'compacted');
    const lines = (await readFile(file, 'utf8')).split('\n');
    assert.equal(lines[0], 'hhhhh');
    assert.match(lines[1] ?? '', MARKER);
    assert.equal(lines[2], 'ttttt');
  });

  it('never splits a UTF-8 character of a kept line and stays readable by the log reader', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `[yami-progress] downloading|${i}%|1MiB/s|ação 日本`);
    await writeFile(file, `${lines.join('\n')}\n`);
    assert.equal(await compactLog(file, { headBytes: 1024, tailBytes: 4096 }), 'compacted');
    const reader = new NodeLogReader(file, 0);
    const read = await reader.drain();
    await reader.close();
    assert.equal(read[0], lines[0]);
    assert.equal(read.at(-1), lines.at(-1));
    assert.ok(read.some((line) => MARKER.test(line)));
    for (const line of read) assert.ok(!line.includes('�'), line);
  });

  it('bounds a huge log to about head + tail with the default limits', async () => {
    const line = `[yami-progress] downloading| 42.0%|  3.10MiB/s|00:12\n`;
    await writeFile(file, line.repeat(Math.ceil((4 * 1024 * 1024) / line.length)));
    assert.equal(await compactLog(file), 'compacted');
    const size = (await readFile(file)).length;
    assert.ok(size <= DEFAULT_LOG_COMPACTION.headBytes + DEFAULT_LOG_COMPACTION.tailBytes + 200, String(size));
    assert.ok(
      size >= DEFAULT_LOG_COMPACTION.headBytes + DEFAULT_LOG_COMPACTION.tailBytes - 2 * line.length,
      String(size)
    );
  });
});
