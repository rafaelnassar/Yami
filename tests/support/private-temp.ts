/**
 * Temp roots for host e2e tests. `os.tmpdir()` is usually `/tmp`, which is
 * world-writable and owned by root — `PathSandbox.validateDownloadDir` rejects
 * those as `shared`. Put the tree under the real user home instead.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makePrivateTemp(prefix: string): string {
  const base = path.join(os.homedir(), '.cache', 'yami-tests');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, prefix));
}
