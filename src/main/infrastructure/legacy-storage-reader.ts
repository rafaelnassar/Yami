/**
 * Reads the legacy renderer's localStorage. The old app loaded its UI from `file://`,
 * so its data lives under the `file://` origin of the default session. We open a hidden,
 * sandboxed window with no preload on an empty local HTML file (no scripts of its own,
 * private to this user: see `legacy-probe-page.ts`) and read the two legacy keys with
 * `executeJavaScript`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';
import { withLegacyProbePage } from './legacy-probe-page.ts';
import type { Logger } from './logger.ts';

const READ_SCRIPT = `(() => {
  try { return localStorage.getItem('yami:v1') ?? localStorage.getItem('artermis:v1'); }
  catch { return null; }
})()`;

export interface LegacyStorageReaderOptions {
  readonly userData: string;
  /** The private app temp dir (`AppPaths.tempDir`, verified 0700 by the bootstrap). */
  readonly tempDir: string;
  readonly timeoutMs?: number;
  readonly logger: Logger;
}

async function readThroughWindow(file: string, timeoutMs: number): Promise<string | null> {
  const win = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  let timer: NodeJS.Timeout | undefined;
  try {
    const read = (async () => {
      await win.loadURL(pathToFileURL(file).toString());
      const value: unknown = await win.webContents.executeJavaScript(READ_SCRIPT, false);
      return typeof value === 'string' ? value : null;
    })();
    // The losing branch of the race must not surface as an unhandled rejection.
    read.catch(() => undefined);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('legacy localStorage read timed out')), timeoutMs);
    });
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

export function createLegacyStorageReader(options: LegacyStorageReaderOptions): () => Promise<string | null> {
  return async () => {
    // No Chromium localStorage at all → fresh install; skip the hidden window.
    if (!existsSync(path.join(options.userData, 'Local Storage'))) return null;
    return withLegacyProbePage(options.tempDir, options.logger, (file) =>
      readThroughWindow(file, options.timeoutMs ?? 10_000)
    );
  };
}
