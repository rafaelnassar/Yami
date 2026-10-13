/**
 * Renders a hash lock as a pip requirements file for
 * `pip install --require-hashes --no-deps -r <file>`:
 *
 *   yt-dlp==2025.11.12 --hash=sha256:<hex> [--hash=sha256:<hex> …]
 *
 * Every field is re-validated (defense in depth after the manifest schema): a
 * name or version that could start an option or break the line is refused.
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { LockedWheel } from '../../application/runtime/python-lock.ts';

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const LOCKFILE_HEADER = '# Hash-locked wheels from the Yami runtime manifest (generated, private).';

export function renderLockfile(lock: readonly LockedWheel[]): Result<string, AppErrorData> {
  if (lock.length === 0) return invalid('empty lock');
  const lines = [LOCKFILE_HEADER];
  for (const wheel of lock) {
    if (!NAME.test(wheel.name) || !VERSION.test(wheel.version)) return invalid(`${wheel.name}==${wheel.version}`);
    const hashes = wheel.sha256.map((digest) => `--hash=sha256:${digest}`);
    if (hashes.length === 0 || !wheel.sha256.every((digest) => SHA256.test(digest)))
      return invalid(`${wheel.name} hashes`);
    lines.push([`${wheel.name}==${wheel.version}`, ...hashes].join(' '));
  }
  return ok(`${lines.join('\n')}\n`);
}

function invalid(detail: string): Result<never, AppErrorData> {
  return err({ code: ErrorCode.VALIDATION_FAILED, params: { detail: `pip lock: ${detail}` } });
}
