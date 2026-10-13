import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { APP_CSP, buildCsp } from './csp.ts';
import { createAppProtocolHandler, resolveAssetPath } from './app-protocol.ts';
import { assetMimeType } from './mime-types.ts';
import { decideNavigation } from './navigation-policy.ts';
import { AppOrigin, resolveDevServerUrl } from './origins.ts';
import { isPermissionAllowed } from './permissions.ts';
import { resolveTrustedSender } from './sender-policy.ts';

const appOrigin = new AppOrigin(null);
const isAppUrl = (url: string): boolean => appOrigin.isAppUrl(url);

describe('AppOrigin', () => {
  it('matches app:// by scheme and host (URL.origin is "null" for custom schemes)', () => {
    assert.equal(appOrigin.isAppUrl('app://yami/index.html?view=tray'), true);
    assert.equal(appOrigin.isAppUrl('app://evil/index.html'), false);
    assert.equal(appOrigin.isAppUrl('file:///C:/Users/x/index.html'), false);
    assert.equal(appOrigin.isAppUrl('not a url'), false);
    assert.equal(appOrigin.entryUrl('tray'), 'app://yami/index.html?view=tray');
  });

  it('uses the dev server only when unpackaged and explicitly requested, and only locally', () => {
    assert.equal(resolveDevServerUrl({ isPackaged: false, env: {} }), null);
    assert.equal(
      resolveDevServerUrl({ isPackaged: true, env: { YAMI_DEV_SERVER_URL: 'http://localhost:5173' } }),
      null
    );
    assert.equal(resolveDevServerUrl({ isPackaged: false, env: { YAMI_DEV: '1' } }), 'http://localhost:5173');
    assert.equal(
      resolveDevServerUrl({ isPackaged: false, env: { YAMI_DEV_SERVER_URL: 'http://127.0.0.1:5999/' } }),
      'http://127.0.0.1:5999'
    );
    assert.equal(resolveDevServerUrl({ isPackaged: false, env: { YAMI_DEV_SERVER_URL: 'http://example.com' } }), null);
    const dev = new AppOrigin('http://localhost:5173');
    assert.equal(dev.isAppUrl('http://localhost:5173/index.html'), true);
    assert.equal(dev.isAppUrl('http://localhost:5174/'), false);
  });
});

describe('sender policy', () => {
  const deps = {
    viewOf: (id: number) => (id === 1 ? ('main' as const) : id === 2 ? ('tray' as const) : null),
    isAppUrl
  };
  const frame = (url: string, parent: unknown = null) => ({ url, parent });

  it('trusts the top frame of our windows on the app origin', () => {
    assert.equal(resolveTrustedSender({ webContentsId: 1, frame: frame('app://yami/index.html') }, deps), 'main');
    assert.equal(
      resolveTrustedSender({ webContentsId: 2, frame: frame('app://yami/index.html?view=tray') }, deps),
      'tray'
    );
  });

  it('rejects foreign windows, sub-frames, missing frames and navigated windows', () => {
    assert.equal(resolveTrustedSender({ webContentsId: 9, frame: frame('app://yami/index.html') }, deps), null);
    assert.equal(resolveTrustedSender({ webContentsId: 1, frame: frame('app://yami/x.html', {}) }, deps), null);
    assert.equal(resolveTrustedSender({ webContentsId: 1, frame: null }, deps), null);
    // Legacy hijack: a dropped local file loaded in the main window kept IPC access.
    assert.equal(resolveTrustedSender({ webContentsId: 1, frame: frame('file:///tmp/evil.html') }, deps), null);
    const destroyed = { url: 'app://yami/index.html', parent: null, isDestroyed: () => true };
    assert.equal(resolveTrustedSender({ webContentsId: 1, frame: destroyed }, deps), null);
  });
});

describe('navigation policy', () => {
  it('allows the app, sends user links out, blocks the rest', () => {
    assert.equal(decideNavigation('app://yami/index.html', isAppUrl, true), 'allow');
    assert.equal(decideNavigation('https://github.com/x', isAppUrl, true), 'external');
    assert.equal(decideNavigation('https://github.com/x', isAppUrl, false), 'block');
    assert.equal(decideNavigation('file:///etc/passwd', isAppUrl, true), 'block');
    assert.equal(decideNavigation('javascript:alert(1)', isAppUrl, true), 'block');
  });
});

describe('permissions', () => {
  it('denies everything except fullscreen and clipboard writes for the app origin', () => {
    assert.equal(isPermissionAllowed('fullscreen', 'app://yami/index.html', isAppUrl), true);
    assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'app://yami', isAppUrl), true);
    assert.equal(isPermissionAllowed('clipboard-read', 'app://yami', isAppUrl), false);
    assert.equal(isPermissionAllowed('media', 'app://yami', isAppUrl), false);
    assert.equal(isPermissionAllowed('fullscreen', 'https://www.pixiv.net', isAppUrl), false);
    assert.equal(isPermissionAllowed('fullscreen', '', isAppUrl), false);
  });
});

describe('app protocol', () => {
  const root = path.resolve('/srv/renderer');

  it('confines paths to the renderer directory', () => {
    assert.equal(resolveAssetPath(root, '/'), path.join(root, 'index.html'));
    assert.equal(resolveAssetPath(root, '/assets/app.js'), path.join(root, 'assets', 'app.js'));
    for (const evil of [
      '/../secret',
      '/assets/%2e%2e/%2e%2e/secret',
      '/..%2fsecret',
      '/..%5csecret',
      '/%2e%2e%5c%2e%2e%5cwin.ini',
      '/C:/Windows/win.ini',
      '/a/.. /b',
      '/x%00.js',
      '/%E0%A4%A'
    ]) {
      assert.equal(resolveAssetPath(root, evil), null, evil);
    }
  });

  it('maps MIME types', () => {
    assert.equal(assetMimeType('index.html'), 'text/html; charset=utf-8');
    assert.equal(assetMimeType('a.JS'), 'text/javascript; charset=utf-8');
    assert.equal(assetMimeType('font.woff2'), 'font/woff2');
    assert.equal(assetMimeType('noext'), 'application/octet-stream');
  });

  it('builds the strict CSP', () => {
    assert.equal(
      APP_CSP,
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: yami-media: https://www.google.com https://*.gstatic.com; media-src 'self' yami-media:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    assert.throws(() => buildCsp({ 'script-src': ["'self'; img-src *"] }));
    assert.throws(() => buildCsp({ 'bad directive': [] }));
  });

  it('serves files with CSP/nosniff headers and 404s everything else', async () => {
    const files = new Map([[path.join(root, 'index.html'), new TextEncoder().encode('<html></html>')]]);
    const handler = createAppProtocolHandler({
      rootDir: root,
      csp: APP_CSP,
      readFile: async (file) => files.get(file) ?? null
    });
    const ok = await handler(new Request('app://yami/index.html'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(ok.headers.get('content-security-policy'), APP_CSP);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await ok.text(), '<html></html>');
    assert.equal((await handler(new Request('app://yami/missing.js'))).status, 404);
    assert.equal((await handler(new Request('app://other/index.html'))).status, 404);
    assert.equal((await handler(new Request('app://yami/index.html', { method: 'POST', body: 'x' }))).status, 405);
  });
});
