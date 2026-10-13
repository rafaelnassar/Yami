/** Types of `pip-lock.mjs` (for the TypeScript tests under tests/). */

export interface LockedWheel {
  readonly name: string;
  readonly version: string;
  readonly sha256: readonly string[];
}

/** `lock.<platform>` marker: python mode is not available there. */
export interface UnsupportedLock {
  readonly unsupported: string;
}

export type LockEntry = readonly LockedWheel[] | UnsupportedLock;

export interface PythonPackagePin {
  readonly requirement: string;
  readonly version: string;
  lock?: Record<string, LockEntry>;
}

export interface ManifestLike {
  readonly tools?: { readonly python?: { readonly assets?: Readonly<Record<string, unknown>> } };
  readonly pythonPackages: Record<string, PythonPackagePin>;
}

export interface LockProblem {
  readonly engine: string;
  readonly platform: string;
  readonly reason: string;
}

export interface Dependency {
  readonly name: string;
  /** Extras the dependency is requested with (`requests[socks]`). */
  readonly extras: readonly string[];
  /** Extras of the requiring package that turn the edge on; empty = always. */
  readonly whenExtras: readonly string[];
}

export interface ReportItem extends LockedWheel {
  readonly requires: readonly Dependency[];
}

export interface PythonCandidate {
  readonly command: string;
  readonly args: readonly string[];
}

export interface FoundPython extends PythonCandidate {
  readonly label: string;
  readonly pythonSeries: string;
}

export declare const PIP_PLATFORM_TAGS: Readonly<Record<string, readonly string[]>>;
export declare const MIN_PIP_VERSION: readonly [number, number];

export declare function normalizeName(name: string): string;
export declare function normalizeVersion(version: string): string;
export declare function requirementName(requirement: string): string;
export declare function pythonSeries(version: string): string;
export declare function pinnedRequirements(pythonPackages: Readonly<Record<string, PythonPackagePin>>): string[];
export declare function pipReportArgs(input: {
  readonly requirements: readonly string[];
  readonly platform: string;
  readonly pythonVersion: string;
  readonly reportFile: string;
  readonly targetDir: string;
}): string[];
export declare function parseDependency(spec: unknown): Dependency | null;
export declare function dependencyName(spec: unknown): string | null;
export declare function readPipReport(report: unknown): ReportItem[];
export declare function locksFromReport(
  report: unknown,
  pins: Readonly<Record<string, { readonly requirement: string; readonly version: string }>>
): Record<string, LockedWheel[]>;
export declare function lockPlatforms(manifest: ManifestLike): string[];
export declare function isUnsupportedLock(lock: unknown): lock is UnsupportedLock;
export declare function unsupportedLock(reason: string): UnsupportedLock;
export declare function lockMatchesPin(lock: LockEntry | undefined, pin: PythonPackagePin): boolean;
export declare function lockProblems(manifest: ManifestLike): LockProblem[];
export declare function platformsNeedingLocks(manifest: ManifestLike): string[];
export declare function unsupportedPlatforms(manifest: ManifestLike): Array<{ platform: string; reason: string }>;
export declare function setPlatformLocks(
  manifest: ManifestLike,
  platform: string,
  locks: Readonly<Record<string, LockEntry>>
): void;
export declare function pruneInvalidLocks(manifest: ManifestLike): string[];
export declare function pythonCandidates(
  env: Readonly<Record<string, string | undefined>>,
  platform: string
): PythonCandidate[];
export declare function parsePipVersion(
  output: string
): { readonly pip: [number, number]; readonly python: string } | null;
export declare function findPython(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  run: (command: string, args: readonly string[]) => Promise<{ readonly ok: boolean; readonly stdout: string }>
): Promise<{ readonly python: FoundPython | null; readonly tried: string[] }>;
