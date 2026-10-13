#!/usr/bin/env node
/**
 * Launch smoke test of the packaged app (`npm run pack` first). Starts the unpacked build with
 * `--yami-smoke-test=<sandbox>` — the app redirects every per-user path into the sandbox, waits
 * until the main window rendered with the preload bridge and the host is ready, quits normally
 * and exits 0 (see src/main/app/smoke-test.ts). Prints the result and, on failure, the tail of
 * the app logs.
 *
 * Usage: node scripts/smoke-packaged.mjs [--exe=<path>] [--timeout=<seconds>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

function defaultExecutable() {
  const release = path.join(ROOT, 'release');
  const candidates =
    {
      win32: [path.join(release, 'win-unpacked', 'Yami.exe')],
      darwin: [
        path.join(release, 'mac-arm64', 'Yami.app', 'Contents', 'MacOS', 'Yami'),
        path.join(release, 'mac', 'Yami.app', 'Contents', 'MacOS', 'Yami')
      ],
      linux: [path.join(release, 'linux-unpacked', 'yami')]
    }[process.platform] ?? [];
  return candidates.find((file) => existsSync(file)) ?? null;
}

function* logFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* logFiles(full);
    else if (entry.name.endsWith('.log')) yield full;
  }
}

function printLogs(sandbox) {
  for (const file of logFiles(sandbox)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    console.log(`\n── ${path.relative(sandbox, file)} (${statSync(file).size} bytes, last 150 lines) ──`);
    console.log(lines.slice(-150).join('\n'));
  }
}

const exe = option('exe') ?? defaultExecutable();
if (!exe || !existsSync(exe)) {
  console.error('smoke: packaged executable not found — run `npm run pack` first (or pass --exe=<path>).');
  process.exit(2);
}
const timeoutMs = Number(option('timeout') ?? 150) * 1000;
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'yami-smoke-'));
console.log(`smoke: ${exe}\nsmoke: sandbox ${sandbox}`);

// Headless Linux CI needs a display server (run under xvfb-run); Windows/macOS runners have a desktop.
const child = spawn(exe, [`--yami-smoke-test=${sandbox}`], { stdio: 'inherit', windowsHide: false });
const timer = setTimeout(() => {
  console.error(`smoke: no exit after ${timeoutMs / 1000} s, killing the app`);
  child.kill('SIGKILL');
}, timeoutMs);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error(`smoke: could not start the app: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const resultFile = path.join(sandbox, 'smoke-result.json');
  const raw = existsSync(resultFile) ? readFileSync(resultFile, 'utf8').trim() : null;
  let passed = false;
  try {
    passed = raw !== null && JSON.parse(raw).ok === true;
  } catch {
    passed = false;
  }
  console.log(`smoke: result ${raw ?? '(no smoke-result.json)'}`);
  console.log(`smoke: exit code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}`);
  // Exit code 0 alone is not enough: the app also exits 0 when, e.g., it lost the single-instance lock.
  if (code === 0 && passed) {
    console.log('smoke: ok');
    process.exit(0);
  }
  printLogs(sandbox);
  process.exit(1);
});
