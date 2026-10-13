/**
 * Runtime manifest: pinned versions + SHA-256 of every downloadable tool, per
 * platform. The JSON lives in `infrastructure/runtime/runtime-manifest.json`
 * (embedded in the host bundle) and is refreshed by
 * `scripts/update-runtime-manifest.mjs`. It is validated here, at load.
 *
 * Python mode: `pythonPackages.<engine>` pins the pip requirement and, per
 * platform, may carry a hash lock (`lock.<platform>`: every wheel to install with
 * its SHA-256, see `python-lock.ts`) or mark python mode unsupported there
 * (`{ unsupported: "<why>" }`, no compatible wheels). Manifests without locks stay
 * valid; the install policy (`python-mode-policy.ts`) decides what a missing or
 * unsupported lock means.
 */
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { ENGINES, type Engine, type ToolId } from '../../../shared/domain/engine.ts';
import { formatIssue, v, type Infer, type Schema, type ValidationIssue } from '../../../shared/validation/schema.ts';
import { lockMismatch, mergeLocks, type LockedWheel } from './python-lock.ts';

export const ARCHIVE_KINDS = ['none', 'zip', 'tar.gz', 'tar.xz'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

export type ManifestPlatform = 'win32' | 'darwin' | 'linux';
export type ManifestArch = 'x64' | 'arm64' | 'ia32';

const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;

/** Relative POSIX path inside an archive; never absolute, never `..`. */
function archivePath(): Schema<string> {
  const base = v.string({ min: 1, max: 260 });
  return {
    parse: (input, path = '') => {
      const parsed = base.parse(input, path);
      if (!parsed.ok) return parsed;
      const segments = parsed.value.split('/');
      const safe = segments.every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..');
      return safe ? parsed : err({ path, reason: 'unsafe archive path' });
    }
  };
}

function httpsUrl(): Schema<string> {
  const base = v.httpUrl();
  return {
    parse: (input, path = '') => {
      const parsed = base.parse(input, path);
      if (!parsed.ok) return parsed;
      return parsed.value.startsWith('https://') ? parsed : err({ path, reason: 'https required' });
    }
  };
}

const version = v.string({ min: 1, max: 64, pattern: /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/ });
const platformKey = v.string({ pattern: /^(win32|darwin|linux)-(x64|arm64|ia32)$/ });
const sha256 = v.string({ pattern: /^[a-f0-9]{64}$/ });

const AssetSchema = v.object({
  version,
  url: httpsUrl(),
  sha256: v.nullable(sha256),
  archive: v.enum(ARCHIVE_KINDS),
  /** Path of the executable inside the archive (required unless `archive` is `none`). */
  entry: v.optional(archivePath()),
  /** Extra executables in the same archive (e.g. `{ "ffprobe": "bin/ffprobe" }`). */
  companions: v.optional(v.record(archivePath(), { maxKeys: 4, key: v.string({ pattern: /^[a-z][a-z0-9-]{0,31}$/ }) })),
  size: v.optional(v.nullable(v.number({ int: true, min: 1, max: 2 * 1024 * 1024 * 1024 })))
});

const ToolSchema = v.object({
  /** Upstream release feed used for "latest" checks (only tools that may float beyond the pin). */
  latest: v.optional(
    v.object({
      repo: v.string({ min: 3, max: 100, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ }),
      checksumsAsset: v.string({ min: 1, max: 100, pattern: SAFE_SEGMENT })
    })
  ),
  assets: v.record(AssetSchema, { maxKeys: 16, key: platformKey })
});

const LockedWheelSchema = v.object({
  /** Project name: starts and ends alphanumeric, so it can never be read as a pip option. */
  name: v.string({ min: 1, max: 100, pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ }),
  version,
  sha256: v.array(sha256, { min: 1, max: 64 })
});

/** `lock.<platform>` when the pins cannot be installed there (no compatible wheel): python mode is refused. */
const UnsupportedLockSchema = v.object({ unsupported: v.string({ min: 1, max: 300 }) });

const LockEntrySchema = v.union(v.array(LockedWheelSchema, { min: 1, max: 200 }), UnsupportedLockSchema);

const PackageSchema = v.object({
  /** pip requirement name with optional extras, e.g. `yt-dlp[default]`. */
  requirement: v.string({ min: 1, max: 80, pattern: /^[A-Za-z0-9._-]+(\[[A-Za-z0-9._,-]+\])?$/ }),
  version,
  /**
   * Per platform: every wheel `requirement==version` installs, hash-pinned, or an
   * unsupported marker (`npm run runtime:pin`).
   */
  lock: v.optional(v.record(LockEntrySchema, { maxKeys: 16, key: platformKey }))
});

type LockEntry = Infer<typeof LockEntrySchema>;

function wheelsOf(entry: LockEntry | undefined): readonly LockedWheel[] | null {
  return entry === undefined || 'unsupported' in entry ? null : entry;
}

export const RuntimeManifestSchema = v.object({
  schemaVersion: v.literal(1),
  tools: v.object({
    'gallery-dl': ToolSchema,
    'yt-dlp': ToolSchema,
    deno: ToolSchema,
    ffmpeg: ToolSchema,
    python: ToolSchema
  }),
  pythonPackages: v.object({ 'gallery-dl': PackageSchema, 'yt-dlp': PackageSchema })
});

export type RuntimeManifest = Infer<typeof RuntimeManifestSchema>;
export type ManifestAsset = Infer<typeof AssetSchema>;
export type PythonPackagePin = Infer<typeof PackageSchema>;

export function parseManifest(input: unknown): Result<RuntimeManifest, ValidationIssue> {
  const parsed = RuntimeManifestSchema.parse(input);
  if (!parsed.ok) return parsed;
  for (const [tool, spec] of Object.entries(parsed.value.tools)) {
    for (const [key, asset] of Object.entries(spec.assets)) {
      if (asset.archive !== 'none' && !asset.entry) {
        return err({ path: `tools.${tool}.assets.${key}.entry`, reason: 'required for archives' });
      }
    }
  }
  const locks = checkLocks(parsed.value);
  return locks ? err(locks) : ok(parsed.value);
}

/**
 * A lock must pin exactly the manifest version of its package (a stale lock after
 * a version bump is a build error, not a silent downgrade), and the engines'
 * locks of one platform must agree on shared dependencies (they may be installed
 * together). Unsupported markers carry no wheels to check.
 */
function checkLocks(manifest: Infer<typeof RuntimeManifestSchema>): ValidationIssue | null {
  const byPlatform = new Map<string, (readonly LockedWheel[])[]>();
  for (const [engine, pin] of Object.entries(manifest.pythonPackages)) {
    for (const [platform, entry] of Object.entries(pin.lock ?? {})) {
      const lock = wheelsOf(entry);
      if (lock === null) continue;
      const mismatch = lockMismatch(lock, pin.requirement, pin.version);
      if (mismatch) return { path: `pythonPackages.${engine}.lock.${platform}`, reason: mismatch };
      byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), lock]);
    }
  }
  for (const [platform, locks] of byPlatform) {
    const merged = mergeLocks(locks);
    if (!merged.ok) {
      return {
        path: `pythonPackages.*.lock.${platform}`,
        reason: `${merged.error.name} locked at ${merged.error.versions.join(' and ')}`
      };
    }
  }
  return null;
}

/** Throws on an invalid manifest: it is embedded at build time, so this is a bug. */
export function assertManifest(input: unknown): RuntimeManifest {
  const parsed = parseManifest(input);
  if (!parsed.ok) throw new Error(`Invalid runtime manifest: ${formatIssue(parsed.error)}`);
  return parsed.value;
}

/** Resolved view of the manifest for the platform the host runs on. */
export interface PlatformManifest {
  readonly platformKey: string;
  asset(tool: ToolId): ManifestAsset | null;
  latestFeed(tool: ToolId): { readonly repo: string; readonly checksumsAsset: string } | null;
  pythonPackage(engine: 'gallery-dl' | 'yt-dlp'): PythonPackagePin;
  /** Hash-locked wheels of `engine` for this platform, `null` when the manifest has no lock for it. */
  pythonLock(engine: Engine): readonly LockedWheel[] | null;
  /** True when every asset of this platform has a SHA-256. */
  readonly fullyPinned: boolean;
  /** True when both engines have a hash lock for this platform (python mode may install). */
  readonly pythonLocked: boolean;
  /** Why python mode is not available on this platform (an engine's lock is marked unsupported), else `null`. */
  readonly pythonUnsupported: string | null;
}

export function resolvePlatform(manifest: RuntimeManifest, platform: ManifestPlatform, arch: string): PlatformManifest {
  const platformKey = `${platform}-${arch}`;
  const assetOf = (tool: ToolId): ManifestAsset | null => manifest.tools[tool].assets[platformKey] ?? null;
  const tools = Object.keys(manifest.tools) as ToolId[];
  const fullyPinned = tools.every((tool) => {
    const asset = assetOf(tool);
    return asset === null || asset.sha256 !== null;
  });
  const entryOf = (engine: Engine): LockEntry | undefined => manifest.pythonPackages[engine].lock?.[platformKey];
  const lockOf = (engine: Engine): readonly LockedWheel[] | null => wheelsOf(entryOf(engine));
  const unsupportedReason = (engine: Engine): string | null => {
    const entry = entryOf(engine);
    return entry !== undefined && 'unsupported' in entry ? entry.unsupported : null;
  };
  return {
    platformKey,
    asset: assetOf,
    latestFeed: (tool) => manifest.tools[tool].latest ?? null,
    pythonPackage: (engine) => manifest.pythonPackages[engine],
    pythonLock: lockOf,
    fullyPinned,
    pythonLocked: ENGINES.every((engine) => lockOf(engine) !== null),
    pythonUnsupported: ENGINES.map(unsupportedReason).find((reason) => reason !== null) ?? null
  };
}

/** File name of an asset URL (last path segment, without query). */
export function assetFileName(url: string): string {
  const path = url.split(/[?#]/)[0] ?? '';
  const raw = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
