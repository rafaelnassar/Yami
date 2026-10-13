import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import type { CommandResult } from '../process/command-runner.ts';
import type { CancellableCommandOptions, CancellableCommandRunner } from './cancellable-command.ts';
import { LOCKFILE_HEADER } from './pip-lockfile.ts';
import { ManagedPipRunner, pipEnvironment } from './pip-runner.ts';

type Call = { readonly file: string; readonly args: readonly string[]; readonly options: CancellableCommandOptions };

function fakeRunner(
  outcome: Partial<CommandResult>,
  lines: string[] = []
): { runner: CancellableCommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CancellableCommandRunner = {
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      for (const line of lines) options.onLine?.(line);
      return { stdout: '', stderr: '', code: 0, error: null, ...outcome };
    }
  };
  return { runner, calls };
}

const root = mkdtempSync(path.join(tmpdir(), 'yami-pip-'));
after(() => rmSync(root, { recursive: true, force: true }));
const signal = new AbortController().signal;
const tmpDir = path.join(root, '.tmp');
const unlocked = (...requirements: string[]) => ({ requirements, lock: null });

describe('ManagedPipRunner', () => {
  it('runs an isolated, wheels-only pip with pinned requirements in a neutral cwd', async () => {
    const { runner, calls } = fakeRunner({}, ['Collecting gallery-dl==1.32.9']);
    const cwd = path.join(root, 'proc-cwd');
    const pip = new ManagedPipRunner({
      env: {
        PATH: '/bin',
        PYTHONPATH: '/evil',
        PIP_INDEX_URL: 'https://evil',
        pip_trusted_host: 'evil',
        PIPX_HOME: '/keep'
      },
      runner,
      cwd,
      tmpDir
    });
    const seen: string[] = [];
    const result = await pip.install(
      '/rt/python/bin/python3',
      unlocked('gallery-dl==1.32.9', 'yt-dlp[default]==2025.11.12'),
      (l) => seen.push(l),
      signal
    );
    assert.ok(result.ok);
    assert.equal(calls[0]?.file, '/rt/python/bin/python3');
    assert.deepEqual(calls[0]?.args, [
      '-I',
      '-X',
      'utf8',
      '-m',
      'pip',
      'install',
      '--isolated',
      '--disable-pip-version-check',
      '--no-input',
      '--only-binary=:all:',
      'gallery-dl==1.32.9',
      'yt-dlp[default]==2025.11.12'
    ]);
    const env = calls[0]?.options.env ?? {};
    assert.equal(env['PYTHONPATH'], undefined);
    assert.equal(env['PIP_INDEX_URL'], undefined);
    assert.equal(env['pip_trusted_host'], undefined);
    assert.equal(env['PIPX_HOME'], '/keep');
    assert.equal(calls[0]?.options.cwd, cwd);
    assert.equal(calls[0]?.options.signal, signal);
    assert.equal(statSync(cwd).isDirectory(), true);
    assert.deepEqual(seen, ['Collecting gallery-dl==1.32.9']);
  });

  it('rejects anything that is not name==version and reports pip errors', async () => {
    const { runner, calls } = fakeRunner({ code: 1 }, ['ERROR: No matching distribution found for gallery-dl==9.9']);
    const pip = new ManagedPipRunner({ env: {}, runner, cwd: root, tmpDir });
    const invalid = await pip.install('/py', unlocked('--index-url=https://evil'), () => {}, signal);
    assert.equal(invalid.ok ? null : invalid.error.code, ErrorCode.VALIDATION_FAILED);
    assert.equal(calls.length, 0);
    const failed = await pip.install('/py', unlocked('gallery-dl==9.9'), () => {}, signal);
    assert.deepEqual(failed.ok ? null : failed.error, {
      code: ErrorCode.TOOLS_INSTALL_FAILED,
      params: { tool: 'python', detail: 'ERROR: No matching distribution found for gallery-dl==9.9' }
    });
  });

  it('maps cancellation, a missing interpreter and timeouts', async () => {
    const cases: Array<[Partial<CommandResult>, unknown]> = [
      [{ code: null, error: 'ABORT_ERR' }, { code: ErrorCode.CANCELLED }],
      [
        { code: null, error: 'ENOENT' },
        { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'python not found' } }
      ],
      [
        { code: null, error: 'ETIMEDOUT' },
        { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'pip timed out' } }
      ]
    ];
    for (const [outcome, expected] of cases) {
      const pip = new ManagedPipRunner({ env: {}, runner: fakeRunner(outcome).runner, cwd: root, tmpDir });
      const result = await pip.install('/py', unlocked('yt-dlp==2025.11.12'), () => {}, signal);
      assert.deepEqual(result.ok ? null : result.error, expected);
    }
  });

  it('installs a hash lock with --require-hashes --no-deps from a private lockfile that is removed afterwards', async () => {
    const lock = [
      { name: 'yt-dlp', version: '2025.11.12', sha256: ['a'.repeat(64)] },
      { name: 'brotli', version: '1.1.0', sha256: ['b'.repeat(64), 'c'.repeat(64)] }
    ];
    const seen: Array<{ args: readonly string[]; path: string; content: string; mode: number; dirMode: number }> = [];
    const runner: CancellableCommandRunner = {
      run: async (_file, args) => {
        const file = args[args.indexOf('-r') + 1] ?? '';
        const content = readFileSync(file, 'utf8');
        seen.push({ args, path: file, content, mode: statSync(file).mode, dirMode: statSync(path.dirname(file)).mode });
        return { stdout: '', stderr: '', code: 0, error: null };
      }
    };
    const pip = new ManagedPipRunner({ env: {}, runner, cwd: root, tmpDir });
    const result = await pip.install('/py', { requirements: ['yt-dlp[default]==2025.11.12'], lock }, () => {}, signal);
    assert.ok(result.ok);
    const written = seen[0];
    assert.ok(written);
    assert.deepEqual(written.args.slice(0, -1), [
      '-I',
      '-X',
      'utf8',
      '-m',
      'pip',
      'install',
      '--isolated',
      '--disable-pip-version-check',
      '--no-input',
      '--only-binary=:all:',
      '--require-hashes',
      '--no-deps',
      '-r'
    ]);
    assert.equal(written.args.includes('yt-dlp[default]==2025.11.12'), false, 'the lock replaces the requirement');
    assert.equal(path.dirname(path.dirname(written.path)), tmpDir);
    assert.equal(
      written.content,
      [
        LOCKFILE_HEADER,
        `yt-dlp==2025.11.12 --hash=sha256:${'a'.repeat(64)}`,
        `brotli==1.1.0 --hash=sha256:${'b'.repeat(64)} --hash=sha256:${'c'.repeat(64)}`,
        ''
      ].join('\n')
    );
    if (process.platform !== 'win32') {
      assert.equal(written.mode & 0o777, 0o600);
      assert.equal(written.dirMode & 0o777, 0o700);
    }
    assert.equal(existsSync(written.path), false, 'lockfile removed');
    assert.deepEqual(readdirSync(tmpDir), []);
  });

  it('refuses a lock entry that could be read as an option', async () => {
    const { runner, calls } = fakeRunner({});
    const pip = new ManagedPipRunner({ env: {}, runner, cwd: root, tmpDir });
    for (const lock of [
      [{ name: '--index-url=https://evil', version: '1.0', sha256: ['a'.repeat(64)] }],
      [{ name: 'ok', version: '1.0 --hash=sha256:x', sha256: ['a'.repeat(64)] }],
      [{ name: 'ok', version: '1.0', sha256: ['XYZ'] }],
      [{ name: 'ok', version: '1.0', sha256: [] }],
      []
    ]) {
      const result = await pip.install('/py', { requirements: ['ok==1.0'], lock }, () => {}, signal);
      assert.equal(result.ok ? null : result.error.code, ErrorCode.VALIDATION_FAILED, JSON.stringify(lock));
    }
    assert.equal(calls.length, 0);
  });

  it('builds the pip environment without PIP_* variables', () => {
    assert.deepEqual(pipEnvironment({ PATH: '/bin', PIP_CONFIG_FILE: '/evil.conf', HOME: '/h' }), {
      PATH: '/bin',
      HOME: '/h',
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1'
    });
  });
});
