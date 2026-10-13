import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeLogReader, NodeLogReaderFactory } from './node-log-reader.ts';

describe('NodeLogReader', () => {
  let dir = '';
  let file = '';
  const readers: NodeLogReader[] = [];

  function reader(offset = 0, limits = {}): NodeLogReader {
    const created = new NodeLogReader(file, offset, limits);
    readers.push(created);
    return created;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-log-'));
    file = path.join(dir, 'job.log');
  });
  afterEach(async () => {
    await Promise.all(readers.splice(0).map((r) => r.close()));
    await rm(dir, { recursive: true, force: true });
  });

  it('returns complete lines and tracks the consumed offset', async () => {
    await writeFile(file, 'a\nb\n\n');
    const r = reader();
    assert.deepEqual(await r.readLines(), ['a', 'b']);
    assert.equal(r.offset, 5);
    assert.deepEqual(await r.readLines(), []);
  });

  it('keeps a partial line until it is terminated', async () => {
    await writeFile(file, 'abc');
    const r = reader();
    assert.deepEqual(await r.readLines(), []);
    assert.equal(r.offset, 0, 'offset excludes the unterminated tail');
    await appendFile(file, 'def\nghi');
    assert.deepEqual(await r.readLines(), ['abcdef']);
    assert.equal(r.offset, 7);
  });

  it('resuming at a persisted offset never loses the start of a partial line (legacy bug)', async () => {
    await writeFile(file, 'one\ntw');
    const first = reader();
    assert.deepEqual(await first.readLines(), ['one']);
    const persisted = first.offset;
    await first.close();
    await appendFile(file, 'o\n');
    const resumed = reader(persisted);
    assert.deepEqual(await resumed.readLines(), ['two']);
  });

  it('decodes UTF-8 characters split across two writes/reads (legacy bug)', async () => {
    const bytes = Buffer.from('ação 🎬 ok\n', 'utf8');
    await writeFile(file, bytes.subarray(0, 2)); // 'a' + first byte of 'ç'
    const r = reader();
    assert.deepEqual(await r.readLines(), []);
    await appendFile(file, bytes.subarray(2, 9)); // ends inside the 4-byte emoji
    assert.deepEqual(await r.readLines(), []);
    await appendFile(file, bytes.subarray(9));
    assert.deepEqual(await r.readLines(), ['ação 🎬 ok']);
  });

  it('decodes correctly when every read boundary falls inside characters', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `linha ${i}: ação 🎬 日本語`);
    await writeFile(file, `${lines.join('\n')}\n`);
    const r = reader(0, { maxReadBytes: 7 });
    const out: string[] = [];
    for (let i = 0; i < 10_000 && out.length < lines.length; i += 1) out.push(...(await r.readLines()));
    assert.deepEqual(out, lines);
  });

  it('decodes correctly across the default 256 KiB chunk boundary', async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `${'é'.repeat(i % 7)}🎬 linha ${i}`);
    await writeFile(file, `${lines.join('\n')}\n`);
    const r = reader();
    const out = await r.drain();
    assert.equal(out.length, lines.length);
    assert.deepEqual(out, lines);
    assert.equal(
      out.some((line) => line.includes('�')),
      false
    );
  });

  it('handles CRLF and lone CR (progress redraws) without empty lines', async () => {
    await writeFile(file, 'a\r\n[download]  10%\r[download]  20%\rb\r');
    const r = reader();
    assert.deepEqual(await r.readLines(), ['a', '[download]  10%', '[download]  20%', 'b']);
    await appendFile(file, '\nc\n');
    assert.deepEqual(await r.readLines(), ['c']);
  });

  it('restarts from 0 when the file is truncated (new engine run)', async () => {
    await writeFile(file, 'first run line\n');
    const r = reader();
    assert.deepEqual(await r.readLines(), ['first run line']);
    await truncate(file, 0);
    await appendFile(file, 'new\n');
    assert.deepEqual(await r.readLines(), ['new']);
    assert.equal(r.offset, 4);
  });

  it('emits over-long lines truncated and discards their remainder', async () => {
    await writeFile(file, `${'a'.repeat(25)}\nnext\n`);
    assert.deepEqual(await reader(0, { maxLineBytes: 10 }).readLines(), ['a'.repeat(10), 'next']);

    await writeFile(file, 'b'.repeat(15));
    const r = reader(0, { maxLineBytes: 10 });
    assert.deepEqual(await r.readLines(), ['b'.repeat(10)]);
    await appendFile(file, 'bbbb\nafter\n');
    assert.deepEqual(await r.readLines(), ['after']);
  });

  it('truncates long lines on a character boundary', async () => {
    await writeFile(file, `${'é'.repeat(8)}\n`); // 16 bytes
    assert.deepEqual(await reader(0, { maxLineBytes: 5 }).readLines(), ['éé']);
  });

  it('drain returns remaining lines plus the trailing partial one', async () => {
    await writeFile(file, 'x\ny');
    const r = reader();
    assert.deepEqual(await r.drain(), ['x', 'y']);
    assert.equal(r.offset, 3);
    assert.deepEqual(await r.drain(), []);
  });

  it('drain is bounded', async () => {
    await writeFile(file, 'aaa\nbbb\nccc\nddd\n');
    const r = reader(0, { maxReadBytes: 4, maxDrainReads: 2 });
    assert.deepEqual(await r.drain(), ['aaa', 'bbb']);
    assert.deepEqual(await r.drain(), ['ccc', 'ddd']);
  });

  it('tolerates a log that does not exist yet and stops after close()', async () => {
    const factory = new NodeLogReaderFactory();
    const r = factory.open(file, -5);
    assert.deepEqual(await r.readLines(), []);
    await writeFile(file, 'late\n');
    assert.deepEqual(await r.readLines(), ['late']);
    await r.close();
    await appendFile(file, 'ignored\n');
    assert.deepEqual(await r.readLines(), []);
  });
});
