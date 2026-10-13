import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APP_CSP } from './csp.ts';
import {
  REACT_REFRESH_PREAMBLE,
  buildDevCsp,
  installDevServerCsp,
  scriptHashSource,
  withCspHeader,
  type WebRequestSession
} from './dev-csp.ts';
import { AppOrigin } from './origins.ts';

const preambleHash = scriptHashSource(REACT_REFRESH_PREAMBLE);

describe('dev server CSP', () => {
  it('is the production policy plus the HMR socket and the React Refresh preamble hash', () => {
    const csp = buildDevCsp('http://localhost:5173');
    assert.match(preambleHash, /^'sha256-[A-Za-z0-9+/]{43}='$/);
    assert.equal(
      csp,
      APP_CSP.replace("script-src 'self'", `script-src 'self' ${preambleHash}`).replace(
        "connect-src 'self'",
        "connect-src 'self' ws://localhost:5173"
      )
    );
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  });

  it('never lists IPv6 literals (not valid CSP host-sources)', () => {
    const csp = buildDevCsp('http://[::1]:5173');
    assert.match(csp, /connect-src 'self';/);
  });

  it('replaces an existing CSP header whatever its casing and keeps the others', () => {
    const headers = withCspHeader(
      { 'content-security-policy': ['x'], 'Content-Type': ['text/html'] },
      "default-src 'self'"
    );
    assert.deepEqual(headers, { 'Content-Type': ['text/html'], 'Content-Security-Policy': ["default-src 'self'"] });
    assert.deepEqual(withCspHeader(undefined, 'p'), { 'Content-Security-Policy': ['p'] });
  });

  it('adds the header only to responses from the dev origin', () => {
    let filter: string[] = [];
    let listener: Parameters<WebRequestSession['webRequest']['onHeadersReceived']>[1] | null = null;
    const session: WebRequestSession = {
      webRequest: {
        onHeadersReceived(registeredFilter, registered) {
          filter = registeredFilter.urls;
          listener = registered;
        }
      }
    };
    installDevServerCsp(session, new AppOrigin('http://localhost:5173'));
    assert.deepEqual(filter, ['http://localhost:5173/*']);
    const run = (url: string) => {
      let response: unknown = null;
      assert.ok(listener);
      listener({ url, responseHeaders: { 'Content-Type': ['text/html'] } }, (value) => {
        response = value;
      });
      return response;
    };
    assert.deepEqual(run('http://localhost:5173/index.html'), {
      responseHeaders: {
        'Content-Type': ['text/html'],
        'Content-Security-Policy': [buildDevCsp('http://localhost:5173')]
      }
    });
    assert.deepEqual(run('http://localhost:5174/index.html'), {});
  });

  it('matches the preamble of the installed @vitejs/plugin-react', async (t) => {
    let preamble: string;
    try {
      preamble = (await import('@vitejs/plugin-react')).default.preambleCode;
    } catch {
      // Vite cannot load without its native rollup binary (e.g. offline sandboxes); CI has it.
      t.skip('@vitejs/plugin-react is not loadable here');
      return;
    }
    assert.equal(preamble.replace('__BASE__', '/'), REACT_REFRESH_PREAMBLE);
  });
});
