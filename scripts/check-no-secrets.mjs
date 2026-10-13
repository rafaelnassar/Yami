#!/usr/bin/env node
/**
 * Fails if secrets, credentials, or personal runtime data are git-tracked, or if
 * secret-looking files sit in the repo root. Used by the release workflow and
 * `npm run check:secrets`. Local folders like `/downloads` may exist on a
 * developer machine (gitignored); they must never be tracked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_TRACKED_PREFIXES = [
  'cookies/',
  'downloads/',
  'native-host/',
  'design-system/',
  'coverage/',
  'release/',
  'release-audit/',
  'dist/',
  'dist-electron/'
];

const FORBIDDEN_TRACKED_BASENAME =
  /^(?:\.env$|\.env\.(?!example$).+|.*\.(?:pem|pfx|p12|key)|credentials\.json|gallery-dl\.exe|yt-dlp\.exe|ffmpeg\.exe)$/i;

/** Secret-looking files that must not sit in the repo root even when gitignored. */
const FORBIDDEN_ROOT_BASENAME =
  /^(?:\.env$|\.env\.(?!example$).+|.*\.(?:pem|pfx|p12|key)|credentials\.json|gallery-dl\.exe)$/i;

/** @param {string} message */
function fail(message) {
  console.error(`check-no-secrets: ${message}`);
  process.exit(1);
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch (error) {
    fail(`git ls-files failed: ${error instanceof Error ? error.message : error}`);
  }
}

for (const file of trackedFiles()) {
  const normalized = file.replace(/\\/g, '/');
  if (
    FORBIDDEN_TRACKED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
  ) {
    fail(`tracked personal/build path must be removed: ${normalized}`);
  }
  const base = path.posix.basename(normalized);
  if (FORBIDDEN_TRACKED_BASENAME.test(base)) {
    fail(`tracked secret/junk file must be removed: ${normalized}`);
  }
}

for (const name of readdirSync(root)) {
  if (!FORBIDDEN_ROOT_BASENAME.test(name)) continue;
  if (existsSync(path.join(root, name)) && statSync(path.join(root, name)).isFile()) {
    fail(`secret/junk file in repo root (move it outside the project): ${name}`);
  }
}

console.log('check-no-secrets: ok');
