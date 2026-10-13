import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ABORTED, ExecFileCancellableRunner, OUTPUT_TOO_LARGE } from './cancellable-command.ts';
import { firstOutputLine, succeeded } from './command-result.ts';

const node = process.execPath;
const runner = new ExecFileCancellableRunner();
const idle = new AbortController().signal;

describe('ExecFileCancellableRunner', () => {
  it('captures output and exit code and streams complete lines (no shell)', async () => {
    const lines: string[] = [];
    const result = await runner.run(
      node,
      ['-e', 'process.stdout.write("a\\nb\\r"); process.stderr.write("c"); process.exit(3)'],
      {
        timeoutMs: 10_000,
        signal: idle,
        onLine: (line) => lines.push(line)
      }
    );
    assert.deepEqual([result.code, result.error], [3, null]);
    assert.equal(result.stdout, 'a\nb\r');
    assert.deepEqual(lines.sort(), ['a', 'b', 'c']);
    assert.equal(succeeded(result), false);
    assert.equal(firstOutputLine(result), 'a');
  });

  it('does not interpret shell metacharacters and honours cwd', async () => {
    const result = await runner.run(
      node,
      ['-e', 'console.log(process.argv[1] + "|" + process.cwd())', '$(echo hi); rm -rf /'],
      {
        timeoutMs: 10_000,
        signal: idle,
        cwd: '/'
      }
    );
    assert.equal(result.stdout.trim(), `$(echo hi); rm -rf /|${path.parse(process.cwd()).root}`);
    assert.ok(succeeded(result));
  });

  it('kills on timeout and on abort, and never starts for an aborted signal', async () => {
    const slow = ['-e', 'setTimeout(() => {}, 60000)'];
    const timedOut = await runner.run(node, slow, { timeoutMs: 50, signal: idle });
    assert.equal(timedOut.error, 'ETIMEDOUT');
    const controller = new AbortController();
    const pending = runner.run(node, slow, { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    assert.equal((await pending).error, ABORTED);
    const already = await runner.run('/nonexistent/yami-tool', [], { timeoutMs: 1_000, signal: controller.signal });
    assert.equal(already.error, ABORTED);
  });

  it('reports a missing executable and output beyond the buffer', async () => {
    assert.equal((await runner.run('/nonexistent/yami-tool', [], { timeoutMs: 1_000, signal: idle })).error, 'ENOENT');
    const big = await runner.run(node, ['-e', 'process.stdout.write("x".repeat(4096))'], {
      timeoutMs: 10_000,
      signal: idle,
      maxBuffer: 100
    });
    assert.equal(big.error, OUTPUT_TOO_LARGE);
  });
});
