/**
 * Builds every infrastructure adapter the runtime-tools service needs, so the
 * composition root only writes:
 *
 *   const adapters = createRuntimeAdapters({ runtimeDir, platform, arch, isPackaged, appVersion, env, homeDir, logger });
 *   const runtime = new RuntimeToolsService({ ...adapters, isPackaged, settings, events, logger });
 */
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { Logger } from '../../application/ports/system.ts';
import type { PlatformManifest } from '../../application/runtime/manifest.ts';
import type {
  ArchiveExtractor,
  Downloader,
  PipRunner,
  ReleasesApi,
  ToolInstaller,
  ToolProbe
} from '../../application/runtime/ports.ts';
import { SystemArchiveExtractor } from './archive-extractor.ts';
import { GithubReleases } from './github-releases.ts';
import { HttpsDownloader } from './https-downloader.ts';
import { loadPlatformManifest } from './manifest-loader.ts';
import { ManagedPipRunner } from './pip-runner.ts';
import { runtimeLayout, type RuntimeLayout } from './runtime-layout.ts';
import { ManagedToolInstaller } from './tool-installer.ts';
import { SystemToolProbe } from './tool-probe.ts';

export interface RuntimeAdaptersOptions {
  readonly runtimeDir: string;
  readonly platform: HostPlatform;
  /** `process.arch` (`x64`, `arm64`, `ia32`, …). */
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly logger: Logger;
  /** Neutral cwd for version probes and pip (defaults to the runtime dir; never the host's launch folder). */
  readonly processCwd?: string;
}

export interface RuntimeAdapters {
  readonly manifest: PlatformManifest;
  readonly layout: RuntimeLayout;
  readonly probe: ToolProbe;
  readonly downloader: Downloader;
  readonly extractor: ArchiveExtractor;
  readonly installer: ToolInstaller;
  readonly pip: PipRunner;
  readonly releases: ReleasesApi;
}

export function createRuntimeAdapters(options: RuntimeAdaptersOptions): RuntimeAdapters {
  const layout = runtimeLayout(options.runtimeDir, options.platform);
  const userAgent = `Yami/${options.appVersion} (+https://github.com/rafaelnassar/Yami)`;
  const logger = options.logger.child({ module: 'runtime-infra' });
  const cwd = options.processCwd ?? options.runtimeDir;
  return {
    manifest: loadPlatformManifest(options.platform, options.arch),
    layout,
    probe: new SystemToolProbe({
      layout,
      platform: options.platform,
      env: options.env,
      homeDir: options.homeDir,
      isPackaged: options.isPackaged,
      cwd,
      logger
    }),
    downloader: new HttpsDownloader({ userAgent }),
    extractor: new SystemArchiveExtractor({ platform: options.platform, env: options.env }),
    installer: new ManagedToolInstaller(layout, logger),
    pip: new ManagedPipRunner({ env: options.env, cwd, tmpDir: layout.tmpDir }),
    releases: new GithubReleases({ userAgent })
  };
}
