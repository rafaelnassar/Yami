/**
 * `DownloadedFileMarker`: tags downloaded files as "from the internet" so the OS
 * applies its protections to them.
 *
 * - Windows: Mark-of-the-Web — the NTFS alternate data stream `<file>:Zone.Identifier`
 *   with `ZoneId=3` (Internet) → SmartScreen, Office Protected View. Volumes
 *   without ADS support (FAT32/exFAT, some network shares) just fail: ignored.
 * - macOS: `com.apple.quarantine` extended attribute via `/usr/bin/xattr` → Gatekeeper.
 * - Linux: no equivalent, no-op.
 * Best effort: every failure is logged (debug/warn), never thrown.
 */
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { DownloadedFileMarker } from '../../application/ports/files.ts';
import type { Logger } from '../../application/ports/system.ts';
import { type Clock, systemClock } from '../../../shared/kernel/clock.ts';
import type { CommandRunner } from '../process/command-runner.ts';
import { errorCodeOf } from './canonical-path.ts';

const XATTR = '/usr/bin/xattr';
const XATTR_TIMEOUT_MS = 5_000;
/** Quarantine flags `0081`: "downloaded, not yet opened" (what browsers write). */
const QUARANTINE_FLAGS = '0081';
const QUARANTINE_AGENT = 'Yami';

export interface NodeFileMarkerOptions {
  readonly platform: HostPlatform;
  readonly runner: CommandRunner;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Writes the ADS on Windows (injectable so the win32 branch is testable on Linux). */
  readonly writeFile?: (target: string, content: string) => Promise<void>;
  /** True for an existing regular file (not a symlink/dir). */
  readonly isRegularFile?: (target: string) => Promise<boolean>;
}

/**
 * `HostUrl` for the zone identifier: the page/file URL without credentials,
 * query or fragment (they may carry tokens). `null` for non-web or invalid URLs.
 */
export function zoneHostUrl(sourceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function zoneIdentifierContent(sourceUrl: string): string {
  const host = zoneHostUrl(sourceUrl);
  return `[ZoneTransfer]\r\nZoneId=3\r\n${host ? `HostUrl=${host}\r\n` : ''}`;
}

export function quarantineValue(nowMs: number): string {
  return `${QUARANTINE_FLAGS};${Math.floor(nowMs / 1000).toString(16)};${QUARANTINE_AGENT};`;
}

async function defaultWriteFile(target: string, content: string): Promise<void> {
  await writeFile(target, content, 'utf8');
}

async function defaultIsRegularFile(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isFile();
  } catch {
    return false;
  }
}

export class NodeFileMarker implements DownloadedFileMarker {
  readonly #platform: HostPlatform;
  readonly #runner: CommandRunner;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #writeFile: (target: string, content: string) => Promise<void>;
  readonly #isRegularFile: (target: string) => Promise<boolean>;

  constructor(options: NodeFileMarkerOptions) {
    this.#platform = options.platform;
    this.#runner = options.runner;
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemClock;
    this.#writeFile = options.writeFile ?? defaultWriteFile;
    this.#isRegularFile = options.isRegularFile ?? defaultIsRegularFile;
  }

  async mark(target: string, sourceUrl: string): Promise<void> {
    if (this.#platform === 'linux') return;
    try {
      if (this.#platform === 'win32') await this.#markWindows(target, sourceUrl);
      else await this.#markMac(target);
    } catch (error) {
      this.#logger.warn('file marking failed', { code: errorCodeOf(error) ?? String(error) });
    }
  }

  async #markWindows(target: string, sourceUrl: string): Promise<void> {
    // A second ':' past the drive letter would name another stream; a relative path
    // would resolve against the host cwd.
    if (!path.win32.isAbsolute(target) || path.win32.basename(target).includes(':')) {
      this.#logger.warn('file marking skipped: unexpected path');
      return;
    }
    // Writing `file:stream` creates an empty `file` when it is missing: check first.
    if (!(await this.#isRegularFile(target))) return;
    try {
      await this.#writeFile(`${target}:Zone.Identifier`, zoneIdentifierContent(sourceUrl));
    } catch (error) {
      // Expected on volumes without alternate data streams (FAT32, exFAT, some shares).
      this.#logger.debug('zone identifier not written', { code: errorCodeOf(error) ?? 'unknown' });
    }
  }

  async #markMac(target: string): Promise<void> {
    // Absolute paths start with '/', so they can never be taken for an xattr option.
    if (!path.posix.isAbsolute(target)) {
      this.#logger.warn('file marking skipped: unexpected path');
      return;
    }
    if (!(await this.#isRegularFile(target))) return;
    const value = quarantineValue(this.#clock.now());
    const result = await this.#runner.run(XATTR, ['-w', 'com.apple.quarantine', value, target], {
      timeoutMs: XATTR_TIMEOUT_MS
    });
    if (result.code !== 0) {
      this.#logger.debug('quarantine attribute not written', { code: result.code, error: result.error });
    }
  }
}
