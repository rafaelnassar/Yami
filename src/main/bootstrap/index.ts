/**
 * Main-process entry (bundled to `dist-electron/main.cjs`).
 * Before `ready`: privileged schemes, global sandbox, AppUserModelId, dev profile isolation,
 * smoke-test sandbox, single-instance lock. After `ready`: the composition root (`start-app.ts`).
 */
import path from 'node:path';
import { app, dialog, protocol } from 'electron';
import { parseSmokeFlag } from '../app/smoke-test.ts';
import { MEDIA_SCHEME_DEFINITION } from '../features/media/media-protocol.ts';
import { APP_SCHEME_DEFINITION } from '../security/app-protocol.ts';
import { applySmokeSandbox, type ActiveSmoke } from './smoke.ts';
import { startApp } from './start-app.ts';

protocol.registerSchemesAsPrivileged([APP_SCHEME_DEFINITION, MEDIA_SCHEME_DEFINITION]);
app.enableSandbox();
// Must equal the electron-builder appId so toasts show the right name/icon.
if (process.platform === 'win32') app.setAppUserModelId('io.yami.desktop');
// Unpackaged runs use their own profile so development never touches real user data.
if (!app.isPackaged && process.env['YAMI_USE_PROD_DATA'] !== '1') {
  app.setPath('userData', path.join(app.getPath('appData'), 'Yami-dev'));
}

function boot(smoke: ActiveSmoke | null): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app
    .whenReady()
    .then(() => startApp(__dirname, smoke))
    .catch((error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      // Nothing else can report a failed bootstrap: show it and exit instead of lingering invisibly.
      if (smoke) process.stderr.write(`yami smoke test: bootstrap failed: ${detail}\n`);
      else dialog.showErrorBox('Yami', detail);
      app.exit(1);
    });
}

// `--yami-smoke-test[=<dir>]` (CI launch check): everything runs inside a sandbox directory.
// If the sandbox cannot be set up, the run stops here instead of touching real user data.
const smokeOptions = parseSmokeFlag(process.argv);
if (!smokeOptions) {
  boot(null);
} else {
  let smoke: ActiveSmoke | null = null;
  try {
    smoke = applySmokeSandbox(smokeOptions);
  } catch (error) {
    process.stderr.write(`yami smoke test: sandbox setup failed: ${String(error)}\n`);
    app.exit(1);
  }
  if (smoke) boot(smoke);
}
