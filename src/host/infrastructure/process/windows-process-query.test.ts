import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isNormalizedCreationDate,
  normalizeCreationDate,
  parsePowershellProcesses,
  parseTasklistCsv,
  powershellQueryArgs,
  tasklistArgs,
  windowsSystemPaths
} from './windows-process-query.ts';

describe('powershellQueryArgs', () => {
  it('builds one batched WQL filter without double quotes', () => {
    const args = powershellQueryArgs([101, 202, 303]);
    assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command']);
    const script = args[4] ?? '';
    assert.match(
      script,
      /Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=101 OR ProcessId=202 OR ProcessId=303'/
    );
    assert.match(script, /ConvertTo-Json -InputObject \$r -Compress/);
    assert.equal(script.includes('"'), false, 'double quotes would be mangled by Windows argv quoting');
    assert.equal(script.toLowerCase().includes('wmic'), false);
  });

  it('uses absolute System32 paths', () => {
    const paths = windowsSystemPaths('C:\\Windows\\');
    assert.equal(paths.powershell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(paths.tasklist, 'C:\\Windows\\System32\\tasklist.exe');
    assert.equal(paths.taskkill, 'C:\\Windows\\System32\\taskkill.exe');
  });
});

describe('parsePowershellProcesses', () => {
  it('parses a batched array', () => {
    const stdout =
      '[{"ProcessId":4242,"Name":"yt-dlp.exe","CreationDate":"2026-09-30T13:12:33.1234567Z","ExecutablePath":"C:\\\\Users\\\\Ana\\\\AppData\\\\Local\\\\Yami\\\\runtime\\\\bin\\\\yt-dlp.exe"},' +
      '{"ProcessId":77,"Name":"Python.EXE","CreationDate":null,"ExecutablePath":null}]\r\n';
    const rows = parsePowershellProcesses(stdout);
    assert.deepEqual(rows, [
      {
        pid: 4242,
        imageName: 'yt-dlp.exe',
        startToken: '2026-09-30T13:12:33.123Z',
        startTokenSource: 'powershell',
        executablePath: 'C:\\Users\\Ana\\AppData\\Local\\Yami\\runtime\\bin\\yt-dlp.exe'
      },
      { pid: 77, imageName: 'python.exe', startToken: null, startTokenSource: null, executablePath: null }
    ]);
  });

  it('accepts a single unwrapped object (PowerShell 5.1) and a BOM', () => {
    const rows = parsePowershellProcesses(
      '\uFEFF{"ProcessId":5,"Name":"gallery-dl.exe","CreationDate":"2026-01-02T03:04:05.0000000Z","ExecutablePath":"C:\\\\x\\\\gallery-dl.exe"}'
    );
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0]?.startToken, '2026-01-02T03:04:05.000Z');
  });

  it('returns [] for empty output and null for garbage or wrong shapes', () => {
    assert.deepEqual(parsePowershellProcesses(''), []);
    assert.deepEqual(parsePowershellProcesses('[]'), []);
    assert.equal(parsePowershellProcesses('Get-CimInstance : Access denied'), null);
    assert.equal(parsePowershellProcesses('[{"Name":"x.exe"}]'), null);
    assert.equal(parsePowershellProcesses('[{"ProcessId":"12"}]'), null);
  });
});

describe('normalizeCreationDate', () => {
  it('normalizes ISO (any precision / offset), DMTF and /Date()/ to the same UTC millisecond token', () => {
    const expected = '2026-09-30T13:12:33.123Z';
    assert.equal(normalizeCreationDate('2026-09-30T13:12:33.1234567Z'), expected);
    assert.equal(normalizeCreationDate('2026-09-30T10:12:33.1239-03:00'), expected);
    assert.equal(normalizeCreationDate('20260930101233.123456-180'), expected);
    assert.equal(normalizeCreationDate(`/Date(${Date.UTC(2026, 8, 30, 13, 12, 33, 123)})/`), expected);
    assert.equal(normalizeCreationDate('2026-09-30T13:12:33Z'), '2026-09-30T13:12:33.000Z');
  });

  it('rejects unknown formats', () => {
    assert.equal(normalizeCreationDate('yesterday'), null);
    assert.equal(normalizeCreationDate('638632123451234567'), null);
  });

  it('distinguishes normalized tokens from legacy tick tokens', () => {
    assert.equal(isNormalizedCreationDate('2026-09-30T13:12:33.123Z'), true);
    assert.equal(isNormalizedCreationDate('638632123451234567'), false);
  });
});

describe('tasklist', () => {
  it('builds filtered and unfiltered arguments', () => {
    assert.deepEqual(tasklistArgs(42), ['/FI', 'PID eq 42', '/FO', 'CSV', '/NH']);
    assert.deepEqual(tasklistArgs(null), ['/FO', 'CSV', '/NH']);
  });

  it('parses CSV rows and ignores informational lines', () => {
    const stdout = [
      '"System Idle Process","0","Services","0","8 K"',
      '"yt-dlp.exe","4242","Console","1","52,120 K"',
      '"Weird ""Name"".exe","99","Console","1","1 K"',
      'INFO: No tasks are running which match the specified criteria.',
      ''
    ].join('\r\n');
    const rows = parseTasklistCsv(stdout);
    assert.equal(rows.get(4242), 'yt-dlp.exe');
    assert.equal(rows.get(99), 'weird "name".exe');
    assert.equal(rows.get(0), 'system idle process');
    assert.equal(rows.size, 3);
  });
});
