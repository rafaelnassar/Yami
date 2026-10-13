/**
 * Loads the runtime manifest embedded in the host bundle (esbuild inlines the JSON)
 * and resolves it for the running platform. Validation failures throw: the file is
 * part of the build, so an invalid one is a bug caught by tests/CI.
 */
import manifestJson from './runtime-manifest.json' with { type: 'json' };
import {
  assertManifest,
  resolvePlatform,
  type ManifestPlatform,
  type PlatformManifest,
  type RuntimeManifest
} from '../../application/runtime/manifest.ts';

export function loadRuntimeManifest(raw: unknown = manifestJson): RuntimeManifest {
  return assertManifest(raw);
}

export function loadPlatformManifest(
  platform: ManifestPlatform,
  arch: string,
  raw: unknown = manifestJson
): PlatformManifest {
  return resolvePlatform(loadRuntimeManifest(raw), platform, arch);
}
