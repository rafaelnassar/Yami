import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32, gzipSync } from 'node:zlib';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { archiversFor, SystemArchiveExtractor } from './archive-extractor.ts';
import type { CommandResult } from '../process/command-runner.ts';
import type { CancellableCommandOptions, CancellableCommandRunner } from './cancellable-command.ts';
import { findEscape, isInside, isUnsafeEntryName } from './path-containment.ts';

const root = mkdtempSync(path.join(tmpdir(), 'yami-extract-'));
after(() => rmSync(root, { recursive: true, force: true }));

const hasTar = spawnSync('tar', ['--version']).status === 0;
const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
// Creating symlinks needs a privilege on Windows (Developer Mode / admin): skip the tests that rely on them.
const canSymlink = ((): boolean => {
  const probe = path.join(root, 'symlink-probe');
  try {
    symlinkSync('target', probe);
    return true;
  } catch {
    return false;
  }
})();

/* ── minimal archive writers (no external tools needed to craft hostile archives) ── */

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function tarEntry(name: string, content = '', type = '0', linkname = ''): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(octal(type === '5' ? 0o755 : 0o644, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(type === '0' ? data.length : 0, 12), 124);
  header.write(octal(0, 12), 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write('ustar\u000000', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, type === '0' ? padded : Buffer.alloc(0)]);
}

function tarGz(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function zipStored(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

let counter = 0;
function workspace(archiveName: string, content: Buffer): { archive: string; dest: string; base: string } {
  counter += 1;
  const base = path.join(root, `case-${counter}`, '.tmp');
  mkdirSync(base, { recursive: true });
  const archive = path.join(base, archiveName);
  writeFileSync(archive, content);
  return { archive, dest: path.join(base, 'out'), base };
}

const extractor = new SystemArchiveExtractor({ platform: 'linux' });
const signal = new AbortController().signal;

describe('SystemArchiveExtractor (system tar/unzip)', { skip: !hasTar }, () => {
  it('extracts a tarball with internal symlinks', { skip: !canSymlink }, async () => {
    const ws = workspace(
      'py.tar.gz',
      tarGz([
        tarEntry('python/', '', '5'),
        tarEntry('python/bin/', '', '5'),
        tarEntry('python/bin/python3.12', '#!/bin/sh\n'),
        tarEntry('python/bin/python3', '', '2', 'python3.12')
      ])
    );
    const result = await extractor.extract('python', ws.archive, ws.dest, 'tar.gz', signal);
    assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
    assert.equal(readFileSync(path.join(ws.dest, 'python', 'bin', 'python3'), 'utf8'), '#!/bin/sh\n');
  });

  it('rejects a `../` member before extracting anything', async () => {
    const ws = workspace('evil.tar.gz', tarGz([tarEntry('ok.txt', 'fine'), tarEntry('../evil.txt', 'pwned')]));
    const result = await extractor.extract('deno', ws.archive, ws.dest, 'tar.gz', signal);
    assert.equal(result.ok ? null : result.error.code, ErrorCode.TOOLS_INSTALL_FAILED);
    assert.match(String(result.ok ? '' : result.error.params?.['detail']), /unsafe archive entry: \.\.\/evil\.txt/);
    assert.equal(existsSync(path.join(ws.base, 'evil.txt')), false);
    assert.equal(existsSync(path.join(ws.dest, 'ok.txt')), false);
  });

  it('rejects (and removes) an extraction containing a symlink that escapes', { skip: !canSymlink }, async () => {
    const outside = path.join(root, 'outside-target');
    mkdirSync(outside, { recursive: true });
    const ws = workspace('link.tar.gz', tarGz([tarEntry('bin/', '', '5'), tarEntry('bin/escape', '', '2', outside)]));
    const result = await extractor.extract('ffmpeg', ws.archive, ws.dest, 'tar.gz', signal);
    assert.equal(result.ok ? null : result.error.code, ErrorCode.TOOLS_INSTALL_FAILED);
    assert.match(String(result.ok ? '' : result.error.params?.['detail']), /bin[/\\]escape/);
    assert.equal(existsSync(ws.dest), false);
  });

  it('extracts zip files and rejects traversal names', { skip: !hasUnzip }, async () => {
    const good = workspace('deno.zip', zipStored([{ name: 'deno', content: 'ELF' }]));
    const ok = await extractor.extract('deno', good.archive, good.dest, 'zip', signal);
    assert.ok(ok.ok, ok.ok ? '' : JSON.stringify(ok.error));
    assert.equal(readFileSync(path.join(good.dest, 'deno'), 'utf8'), 'ELF');

    const evil = workspace('evil.zip', zipStored([{ name: '../../evil', content: 'x' }]));
    const bad = await extractor.extract('deno', evil.archive, evil.dest, 'zip', signal);
    assert.equal(bad.ok, false);
  });
});

describe('archive tool selection', () => {
  it('uses the absolute Windows tar.exe and falls back from unzip to bsdtar on Linux', () => {
    const win = archiversFor('win32', 'zip', { SystemRoot: 'D:\\Win' });
    assert.deepEqual(
      win.map((a) => a.command),
      ['D:\\Win\\System32\\tar.exe']
    );
    assert.deepEqual(win[0]?.extract('a.zip', 'out'), ['-xf', 'a.zip', '-C', 'out']);
    assert.deepEqual(
      archiversFor('darwin', 'tar.gz', {}).map((a) => a.command),
      ['/usr/bin/tar']
    );
    assert.deepEqual(
      archiversFor('linux', 'zip', {}).map((a) => a.command),
      ['unzip', 'bsdtar']
    );
    assert.deepEqual(
      archiversFor('linux', 'tar.xz', {}).map((a) => a.command),
      ['tar']
    );
  });

  type Call = { file: string; args: readonly string[]; options: CancellableCommandOptions };
  function fakeRunner(respond: (call: Call) => CommandResult): { runner: CancellableCommandRunner; calls: Call[] } {
    const calls: Call[] = [];
    const runner: CancellableCommandRunner = {
      run: async (file, args, options) => {
        const call = { file, args, options };
        calls.push(call);
        return respond(call);
      }
    };
    return { runner, calls };
  }

  it('tries the next archiver when one is not installed and passes relative paths', async () => {
    const { runner, calls } = fakeRunner((call) =>
      call.file === 'unzip'
        ? { stdout: '', stderr: '', code: null, error: 'ENOENT' }
        : { stdout: 'deno\n', stderr: '', code: 0, error: null }
    );
    const ws = workspace('x.zip', Buffer.from('zip'));
    const fake = new SystemArchiveExtractor({ platform: 'linux', runner });
    const result = await fake.extract('deno', ws.archive, ws.dest, 'zip', signal);
    assert.ok(result.ok);
    assert.deepEqual(
      calls.map((c) => [c.file, ...c.args]),
      [
        ['unzip', '-Z1', 'x.zip'],
        ['bsdtar', '-tf', 'x.zip'],
        ['bsdtar', '-xf', 'x.zip', '-C', 'out']
      ]
    );
    assert.equal(calls[0]?.options.cwd, ws.base);
    assert.equal(calls[0]?.options.signal, signal);
  });

  it('maps cancellation and an oversized listing', async () => {
    const aborted = fakeRunner(() => ({ stdout: '', stderr: '', code: null, error: 'ABORT_ERR' }));
    const ws = workspace('y.tar.gz', Buffer.from('tgz'));
    const cancelled = await new SystemArchiveExtractor({ platform: 'linux', runner: aborted.runner }).extract(
      'deno',
      ws.archive,
      ws.dest,
      'tar.gz',
      signal
    );
    assert.equal(cancelled.ok ? null : cancelled.error.code, ErrorCode.CANCELLED);

    const huge = fakeRunner(() => ({
      stdout: 'a\n',
      stderr: '',
      code: null,
      error: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    }));
    const tooLarge = await new SystemArchiveExtractor({ platform: 'linux', runner: huge.runner }).extract(
      'deno',
      ws.archive,
      ws.dest,
      'tar.gz',
      signal
    );
    assert.deepEqual(tooLarge.ok ? null : tooLarge.error, {
      code: ErrorCode.TOOLS_INSTALL_FAILED,
      params: { tool: 'deno', detail: 'archive listing too large' }
    });
    assert.equal(huge.calls.length, 1, 'nothing is extracted after a clipped listing');
  });
});

describe('path containment', () => {
  it('flags unsafe member names', () => {
    for (const name of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'c:/x', 'a\\..\\x'])
      assert.ok(isUnsafeEntryName(name), name);
    for (const name of ['a/b', './a', 'a..b/c', '..a', '']) assert.equal(isUnsafeEntryName(name), false, name);
  });

  it('checks containment lexically', () => {
    assert.ok(isInside('/a/b', '/a/b/c'));
    assert.ok(isInside('/a/b', '/a/b'));
    assert.equal(isInside('/a/b', '/a/bc'), false);
    assert.equal(isInside('/a/b', '/a'), false);
    assert.equal(isInside('C:\\rt', 'c:\\RT\\bin', path.win32), true);
  });

  it('finds escaping symlinks in an extracted tree', { skip: !canSymlink }, async () => {
    const tree = path.join(root, 'tree');
    mkdirSync(path.join(tree, 'lib'), { recursive: true });
    writeFileSync(path.join(tree, 'lib', 'real'), 'x');
    symlinkSync('real', path.join(tree, 'lib', 'inside'));
    assert.equal(await findEscape(tree), null);
    symlinkSync('../../..', path.join(tree, 'lib', 'up'));
    assert.equal(await findEscape(tree), path.join('lib', 'up'));
  });
});
