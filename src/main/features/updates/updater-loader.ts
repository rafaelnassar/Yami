/**
 * Lazy loader for electron-updater. It is imported on demand so a missing or broken
 * package (dev containers, unsupported targets) only disables updates.
 */
import type { Logger } from '../../infrastructure/logger.ts';
import type { UpdaterEngine } from './updater.ts';

function isEngine(value: unknown): value is UpdaterEngine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'checkForUpdates') === 'function' &&
    typeof Reflect.get(value, 'quitAndInstall') === 'function' &&
    typeof Reflect.get(value, 'on') === 'function'
  );
}

export async function loadElectronUpdater(logger: Logger): Promise<UpdaterEngine | null> {
  try {
    const mod: unknown = await import('electron-updater');
    // CJS interop: the named export may sit on the namespace or on `default`.
    const direct: unknown = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'autoUpdater') : undefined;
    const fallback: unknown =
      typeof mod === 'object' && mod !== null
        ? Reflect.get(Object(Reflect.get(mod, 'default')), 'autoUpdater')
        : undefined;
    const engine = isEngine(direct) ? direct : isEngine(fallback) ? fallback : null;
    if (!engine) logger.warn('electron-updater loaded without a usable autoUpdater');
    return engine;
  } catch (error) {
    logger.warn('electron-updater unavailable; updates disabled', { error: String(error) });
    return null;
  }
}
