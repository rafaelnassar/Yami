/**
 * Open risk of a library entry (what main may do with `shell.openPath`).
 *
 * Opening a plain folder only shows it in the file manager, but some folders are
 * *launched* by the OS instead: macOS bundles/installers (`Evil.app` is a
 * directory that Finder runs) and Windows shell-namespace junctions
 * (`name.{CLSID}` folders Explorer hands to a COM handler). Those are never
 * opened by the app.
 */
import { fileOpenRisk, type FileRisk } from '../../../shared/domain/media.ts';

/** Directory extensions that macOS Launch Services executes or installs. */
export const BUNDLE_DIRECTORY_EXTENSIONS: readonly string[] = [
  '.app',
  '.pkg',
  '.mpkg',
  '.bundle',
  '.framework',
  '.appex',
  '.xpc',
  '.prefpane',
  '.saver',
  '.qlgenerator',
  '.kext',
  '.plugin',
  '.action',
  '.workflow'
];

const BUNDLE_EXTENSIONS = new Set(BUNDLE_DIRECTORY_EXTENSIONS);

const CLSID_SUFFIX = /\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

/**
 * Windows ignores trailing dots and spaces (`Evil.app. ` resolves like
 * `Evil.app`), so they are stripped before classifying; a false positive only
 * turns "open" into "reveal", never the other way round.
 */
function significantName(name: string): string {
  return name.normalize('NFC').replace(/[. ]+$/, '');
}

/** True for a directory name the OS would launch instead of browsing. */
export function isLaunchableDirectoryName(name: string): boolean {
  const significant = significantName(name);
  if (CLSID_SUFFIX.test(significant)) return true;
  const dot = significant.lastIndexOf('.');
  return dot >= 0 && BUNDLE_EXTENSIONS.has(significant.slice(dot).toLowerCase());
}

export function directoryOpenRisk(name: string): FileRisk {
  return isLaunchableDirectoryName(name) ? 'blocked' : 'safe';
}

/** Risk of opening `name`; directories follow the bundle/junction rule above, files the shared extension policy. */
export function entryOpenRisk(name: string, isDirectory: boolean): FileRisk {
  return isDirectory ? directoryOpenRisk(name) : fileOpenRisk(name);
}
