#!/usr/bin/env node
/**
 * Runs every `*.test.ts` under src/ and tests/ with Node's built-in test runner.
 * TypeScript is executed natively (type stripping, Node >= 22.18) — the codebase
 * uses only erasable syntax (`erasableSyntaxOnly` in tsconfig).
 *
 * Usage: npm test [-- <path filter>]
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git']);

function collect(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collect(full, out);
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// Filters use `/` on every OS (`npm test -- tests/host-` must also match `tests\host-…` on Windows).
const toPosix = (value) => value.replaceAll('\\', '/');
const filters = process.argv.slice(2).map(toPosix);
const files = [...collect(path.join(ROOT, 'src'), []), ...collect(path.join(ROOT, 'tests'), [])]
  .filter((file) => filters.length === 0 || filters.some((f) => toPosix(file).includes(f)))
  .sort();

if (files.length === 0) {
  console.error('No test files matched.');
  process.exit(1);
}

const nodeArgs = ['--test', '--test-reporter=spec', '--disable-warning=ExperimentalWarning'];
if (!process.features.typescript) nodeArgs.push('--experimental-strip-types');

const result = spawnSync(process.execPath, [...nodeArgs, ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', YAMI_TEST: '1' }
});
process.exit(result.status ?? 1);
