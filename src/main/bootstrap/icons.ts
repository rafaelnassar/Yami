/** Icon files copied next to the main bundle (`dist-electron/icons`). */
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AppIcons {
  readonly window: string | null;
  readonly tray: string | null;
  readonly notification: string | null;
}

function first(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export function resolveIcons(bundleDir: string, platform: NodeJS.Platform): AppIcons {
  const dir = path.join(bundleDir, 'icons');
  return {
    window: first(dir, platform === 'win32' ? ['icon.ico', 'icon-256.png'] : ['icon-256.png', 'icon-128.png']),
    tray: first(
      dir,
      platform === 'win32'
        ? ['icon.ico', 'icon-32.png']
        : platform === 'darwin'
          ? ['icon-16.png', 'icon-32.png']
          : ['icon-32.png', 'icon-16.png']
    ),
    notification: first(dir, ['icon-128.png', 'icon-256.png', 'icon-48.png'])
  };
}
