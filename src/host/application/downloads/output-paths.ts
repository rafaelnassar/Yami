/**
 * Rules for paths printed by engines. Engine output can be influenced by the
 * remote site (titles, file names), so a printed path is only trusted — stat'd,
 * recorded, marked — when it lies lexically inside the run's download dir.
 *
 * Pure (the application layer cannot use `node:path`); separator and case rules
 * come from `domain/library/paths.ts` (`\` and case-insensitive on Windows only).
 */
import type { Engine } from '../../../shared/domain/engine.ts';
import {
  isAbsolutePath,
  isSameOrInside,
  joinPath,
  normalizeSeparators,
  pathFlavorFor,
  relativeSegments,
  trimTrailingSeparators,
  type PathFlavor
} from '../../domain/library/paths.ts';
import type { HostPlatform } from '../ports/engines.ts';

export class OutputPaths {
  readonly #flavor: PathFlavor;
  readonly #windows: boolean;

  constructor(platform: HostPlatform) {
    this.#flavor = pathFlavorFor(platform);
    this.#windows = platform === 'win32';
  }

  /** Per-engine output root (`<download dir>/gallery-dl`, `<download dir>/yt-dlp`), as in the legacy layout. */
  engineDir(downloadDir: string, engine: Engine): string {
    return joinPath(downloadDir, engine, this.#flavor);
  }

  /** Absolute form of an engine-printed path; relative ones (`./x`, `.\x`, `x/y`) are resolved against `dir`. */
  resolve(dir: string, path: string): string {
    if (!dir || isAbsolutePath(path)) return path;
    const separator = this.#flavor.separator;
    const head = trimTrailingSeparators(normalizeSeparators(dir, this.#flavor));
    const tail = normalizeSeparators(path.replace(/^(?:\.[\\/]+)+/, ''), this.#flavor);
    return head.endsWith(separator) ? `${head}${tail}` : `${head}${separator}${tail}`;
  }

  /**
   * True when `path` names something strictly below one of `roots`, judged
   * lexically (before any filesystem access): no `..` segments, NUL, Windows
   * device namespaces or alternate data streams, and a UNC path only under a
   * UNC root.
   */
  isTrusted(path: string, roots: readonly string[]): boolean {
    if (!path || path.includes('\0') || this.#hasParentSegment(path)) return false;
    if (this.#windows && (/^[\\/]{2}[?.][\\/]/.test(path) || path.indexOf(':', 2) !== -1)) return false;
    const unc = this.#isUnc(path);
    return roots.some((root) => {
      if (!root || (unc && !this.#isUnc(root))) return false;
      const below = relativeSegments(root, path, this.#flavor);
      return below !== null && below.length > 0;
    });
  }

  /** True when `path` is one of `dirs` or below it (private directory checks). */
  isInsideAny(path: string, dirs: readonly (string | null)[]): boolean {
    return dirs.some((dir) => !!dir && isSameOrInside(dir, path, this.#flavor));
  }

  #hasParentSegment(path: string): boolean {
    const segments = this.#windows ? path.split(/[\\/]/) : path.split('/');
    return segments.includes('..');
  }

  #isUnc(path: string): boolean {
    return this.#windows ? /^[\\/]{2}[^\\/]/.test(path) : path.startsWith('//');
  }
}
