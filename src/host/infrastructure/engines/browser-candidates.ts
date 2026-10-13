/**
 * Browsers whose cookie store yt-dlp can read, with the profile directory that
 * proves the browser is installed and the process names that prove it is running
 * (legacy lists, spec 03 §5.5). Pure: paths are built for the given platform.
 */
import path from 'node:path';
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { CookieBrowser } from './browser-cookie-spec.ts';

export interface BrowserCandidate {
  readonly browser: CookieBrowser;
  readonly profileDir: string;
  /** Lower-case executable/process names. */
  readonly processNames: readonly string[];
}

export interface CandidateEnvironment {
  readonly platform: HostPlatform;
  readonly homeDir: string;
  /** Case-insensitive on Windows. */
  readonly getEnv: (name: string) => string | undefined;
}

type Row = readonly [CookieBrowser, readonly string[], readonly string[]];

function candidates(
  rows: readonly Row[],
  join: (...parts: string[]) => string,
  root: string | null
): BrowserCandidate[] {
  if (!root) return [];
  return rows.map(([browser, parts, processNames]) => ({
    browser,
    profileDir: join(root, ...parts),
    processNames: processNames.map((name) => name.toLowerCase())
  }));
}

function windowsCandidates(env: CandidateEnvironment): BrowserCandidate[] {
  const join = (...parts: string[]): string => path.win32.join(...parts);
  const localAppData = env.getEnv('LOCALAPPDATA') || join(env.homeDir, 'AppData', 'Local');
  const appData = env.getEnv('APPDATA') || join(env.homeDir, 'AppData', 'Roaming');
  return [
    ...candidates(
      [
        ['chrome', ['Google', 'Chrome', 'User Data'], ['chrome.exe', 'chrome']],
        ['edge', ['Microsoft', 'Edge', 'User Data'], ['msedge.exe', 'msedge']],
        ['brave', ['BraveSoftware', 'Brave-Browser', 'User Data'], ['brave.exe']]
      ],
      join,
      localAppData
    ),
    ...candidates([['firefox', ['Mozilla', 'Firefox', 'Profiles'], ['firefox.exe']]], join, appData)
  ];
}

function macCandidates(env: CandidateEnvironment): BrowserCandidate[] {
  const join = (...parts: string[]): string => path.posix.join(...parts);
  return candidates(
    [
      ['chrome', ['Google', 'Chrome'], ['Google Chrome']],
      ['edge', ['Microsoft Edge'], ['Microsoft Edge']],
      ['brave', ['BraveSoftware', 'Brave-Browser'], ['Brave Browser']],
      ['vivaldi', ['Vivaldi'], ['Vivaldi']],
      ['opera', ['com.operasoftware.Opera'], ['Opera']],
      ['firefox', ['Firefox', 'Profiles'], ['firefox']]
    ],
    join,
    join(env.homeDir, 'Library', 'Application Support')
  );
}

function linuxCandidates(env: CandidateEnvironment): BrowserCandidate[] {
  const join = (...parts: string[]): string => path.posix.join(...parts);
  return [
    ...candidates(
      [
        ['chrome', ['google-chrome'], ['chrome', 'google-chrome']],
        ['chromium', ['chromium'], ['chromium']],
        ['edge', ['microsoft-edge'], ['msedge', 'microsoft-edge']],
        ['brave', ['BraveSoftware', 'Brave-Browser'], ['brave', 'brave-browser']],
        ['vivaldi', ['vivaldi'], ['vivaldi']],
        ['opera', ['opera'], ['opera']]
      ],
      join,
      join(env.homeDir, '.config')
    ),
    ...candidates([['firefox', ['firefox'], ['firefox']]], join, join(env.homeDir, '.mozilla'))
  ];
}

/** Candidates in preference order for the platform. */
export function browserCandidates(env: CandidateEnvironment): BrowserCandidate[] {
  switch (env.platform) {
    case 'win32':
      return windowsCandidates(env);
    case 'darwin':
      return macCandidates(env);
    default:
      return linuxCandidates(env);
  }
}
