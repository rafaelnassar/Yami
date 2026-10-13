import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FileLogger } from './file-logger.ts';
import { formatFields } from './log-fields.ts';

const FIXED = Date.UTC(2026, 8, 30, 12, 0, 0, 0);

describe('FileLogger', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'yami-logger-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function logger(options: Partial<ConstructorParameters<typeof FileLogger>[0]> = {}): FileLogger {
    return new FileLogger({ logsDir: dir, clock: { now: () => FIXED }, minLevel: 'debug', ...options });
  }

  async function lines(file = path.join(dir, 'host.log')): Promise<string[]> {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  }

  it('writes `ISO LEVEL message {json}` lines asynchronously to host.log (0600)', async () => {
    const log = logger();
    log.info('download started', { id: 'abc', attempt: 2 });
    log.warn('no fields');
    await log.flush();
    assert.deepEqual(await lines(), [
      '2026-09-30T12:00:00.000Z INFO  download started {"id":"abc","attempt":2}',
      '2026-09-30T12:00:00.000Z WARN  no fields'
    ]);
    if (process.platform !== 'win32') assert.equal((await stat(log.file)).mode & 0o777, 0o600);
  });

  it('filters by level', async () => {
    const log = logger({ minLevel: 'warn' });
    log.debug('d');
    log.info('i');
    log.error('e');
    await log.flush();
    assert.deepEqual(
      (await lines()).map((line) => line.split(' ')[1]),
      ['ERROR']
    );
  });

  it('redacts secrets and private paths in messages and string fields', async () => {
    const vault = path.join(dir, 'data', 'vault');
    const log = logger({ sensitiveDirs: [vault] });
    log.info(`spawn yt-dlp --cookies ${vault}/c.txt https://x.com/a?token=abc`, {
      args: ['--password', 'hunter2'],
      url: 'https://user:pw@example.com/p?sig=1',
      nested: { file: `${vault}/k.bin`, refreshToken: 'r-123' },
      authorization: 'Bearer abc.def'
    });
    await log.flush();
    const text = (await readFile(log.file, 'utf8')).trim();
    for (const secret of ['hunter2', 'abc.def', 'r-123', 'token=abc', 'user:pw', vault]) {
      assert.equal(text.includes(secret), false, `leaked ${secret}: ${text}`);
    }
    assert.match(text, /\[redacted\]/);
    assert.match(text, /\[private-path\]/);
  });

  it('child loggers merge bindings and share the sink/settings', async () => {
    const log = logger();
    const child = log.child({ component: 'downloads' }).child({ id: 'x1' });
    child.info('tick', { id: 'override' });
    log.configure({ minLevel: 'error' });
    child.info('filtered by the parent setting');
    await log.flush();
    assert.deepEqual(await lines(), ['2026-09-30T12:00:00.000Z INFO  tick {"component":"downloads","id":"override"}']);
  });

  it('keeps entries on one line and serializes errors safely', async () => {
    const log = logger();
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    log.error('boom\nsecond line', { error: new Error('bad password=secret1'), circular });
    await log.flush();
    const all = await lines();
    assert.equal(all.length, 1);
    assert.match(all[0] ?? '', /boom\\nsecond line/);
    assert.equal((all[0] ?? '').includes('secret1'), false);
    assert.match(all[0] ?? '', /"circular":\{"a":1,"self":"\[circular\]"\}/);
  });

  it('rotates at maxBytes keeping maxFiles files in total', async () => {
    const log = logger({ maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 20; i += 1) {
      log.info(`message number ${i} ${'x'.repeat(40)}`);
      await log.flush();
    }
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['host.log', 'host.log.1', 'host.log.2']);
    for (const name of files) assert.ok((await stat(path.join(dir, name))).size <= 200, name);
    assert.match((await lines()).at(-1) ?? '', /message number 19/);
  });

  it('flushSync writes pending lines immediately (fatal paths)', async () => {
    const log = logger();
    log.error('fatal: uncaught exception');
    log.flushSync();
    assert.deepEqual(await lines(), ['2026-09-30T12:00:00.000Z ERROR fatal: uncaught exception']);
  });

  it('flushes on its own shortly after writes', async () => {
    const log = logger({ flushDelayMs: 5 });
    log.info('eventually');
    const start = Date.now();
    let text = '';
    while (!text.includes('eventually') && Date.now() - start < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      text = await readFile(log.file, 'utf8').catch(() => '');
    }
    assert.match(text, /eventually/);
  });
});

describe('formatFields', () => {
  it('drops undefined/functions, stringifies bigints and bounds arrays', () => {
    const json = formatFields(
      { a: undefined, f: () => 1, big: 10n, list: Array.from({ length: 60 }, (_, i) => i) },
      (s) => s
    );
    const parsed = JSON.parse(json) as { big: string; list: unknown[] };
    assert.equal(parsed.big, '10');
    assert.equal(parsed.list.length, 51);
    assert.equal(
      formatFields({}, (s) => s),
      ''
    );
  });
});
