/**
 * Moves an unreadable secret vault aside so a new key and an empty vault can be created
 * (see `features/vault/vault-reset-service.ts`). Nothing is ever deleted: `vault/` (with
 * `key.bin` and the encrypted secrets) becomes `vault.broken-<timestamp>/` next to it and
 * stays there for manual recovery (e.g. after the old Windows password is restored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, appError, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import { renameWithRetrySync } from './atomic-file.ts';
import { describeError, type Logger } from './logger.ts';

export interface VaultLocation {
  readonly vaultDir: string;
  /** Moved on its own only when it lives outside `vaultDir` (it normally lives inside). */
  readonly keyFile: string;
}

const MAX_NAME_ATTEMPTS = 100;

/** `.broken-2026-09-30T12-34-56-789Z`: sortable and valid on every filesystem. */
export function brokenSuffix(now: number): string {
  return `.broken-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function exists(target: string): boolean {
  return fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

/** `base`, or `base-2`, `base-3`… when an earlier reset already used the name. */
function freeName(base: string): string {
  if (!exists(base)) return base;
  for (let n = 2; n <= MAX_NAME_ATTEMPTS; n += 1) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error('no free name for the broken vault');
}

function errnoCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'rename';
}

/**
 * Renames the vault (and an outside key file) to `*.broken-<timestamp>`. Returns the new
 * locations — empty when there was nothing to move. Must run while no host process uses
 * the vault.
 */
export function moveVaultAsideSync(
  location: VaultLocation,
  now: number,
  logger: Logger
): Result<readonly string[], AppErrorData> {
  const suffix = brokenSuffix(now);
  const targets = isInside(location.keyFile, location.vaultDir)
    ? [location.vaultDir]
    : [location.vaultDir, location.keyFile];
  const moved: string[] = [];
  for (const target of targets) {
    if (!exists(target)) continue;
    try {
      const destination = freeName(`${target}${suffix}`);
      renameWithRetrySync(target, destination);
      moved.push(destination);
    } catch (error) {
      logger.error('could not move the vault aside', describeError(error));
      return err(appError(ErrorCode.FILE_OPERATION_FAILED, { detail: errnoCode(error) }));
    }
  }
  return ok(moved);
}
