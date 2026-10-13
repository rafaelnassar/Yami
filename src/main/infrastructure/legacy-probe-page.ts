/**
 * Throw-away local page for the legacy localStorage probe (`legacy-storage-reader.ts`).
 * It is loaded in the `file://` origin, so nobody else may be able to replace it: it is
 * written with mode 0600 and exclusive create (never through a planted link) into a fresh
 * random 0700 subdirectory of the private temp dir, and removed with that directory.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './logger.ts';

/** No scripts of its own: the probe only needs a document in the `file://` origin. */
export const PROBE_HTML = '<!doctype html><meta charset="utf-8"><title></title>';

export async function withLegacyProbePage<T>(
  tempDir: string,
  logger: Logger,
  use: (file: string) => Promise<T>
): Promise<T> {
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(tempDir, 'legacy-probe-'));
  try {
    const file = path.join(dir, 'probe.html');
    await writeFile(file, PROBE_HTML, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) =>
      logger.debug('temp cleanup failed', { error: String(error) })
    );
  }
}
