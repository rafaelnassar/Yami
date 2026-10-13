/**
 * Builds every infrastructure adapter of the host from the `system.configure`
 * payload. Pure construction — no start-up side effects besides opening SQLite.
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AppError } from '../../shared/kernel/errors.ts';
import type { VaultStatusDto } from '../../shared/contracts/dto.ts';
import type { CommandPayload } from '../../shared/contracts/host-protocol.ts';
import type { HostPlatform } from '../application/ports/engines.ts';
import type { CookieVault, CredentialVault } from '../application/ports/secrets.ts';
import { FileLogger } from '../infrastructure/logging/file-logger.ts';
import { createSqlitePersistence, type SqlitePersistence } from '../infrastructure/persistence/sqlite-persistence.ts';
import { SecretBox } from '../infrastructure/security/secret-box.ts';
import { DisabledCookieVault, DisabledCredentialVault } from '../infrastructure/security/disabled-vault.ts';
import { EncryptedCookieVault } from '../infrastructure/security/encrypted-cookie-vault.ts';
import { EncryptedCredentialVault } from '../infrastructure/security/encrypted-credential-vault.ts';
import { ExecFileCommandRunner } from '../infrastructure/process/command-runner.ts';
import { OsProcessIdentityReader } from '../infrastructure/process/process-identity-reader.ts';
import { NodeProcessLauncher } from '../infrastructure/process/node-process-launcher.ts';
import { NodeProcessInspector } from '../infrastructure/process/node-process-inspector.ts';
import { NodeProcessTerminator } from '../infrastructure/process/node-process-terminator.ts';
import { NodePathSandbox } from '../infrastructure/fs/node-path-sandbox.ts';
import { NodeFileSystem } from '../infrastructure/fs/node-file-system.ts';
import { NodeLibraryScanner } from '../infrastructure/fs/node-library-scanner.ts';
import { NodeJobWorkspace } from '../infrastructure/fs/node-job-workspace.ts';
import { NodeLogReaderFactory } from '../infrastructure/fs/node-log-reader.ts';
import { NodeFileMarker } from '../infrastructure/fs/node-file-marker.ts';
import { ScrubbedEngineEnvironment } from '../infrastructure/engines/engine-environment.ts';
import { DirectoryTrust } from '../infrastructure/runtime/path-trust.ts';
import { SystemBrowserCookieDetector } from '../infrastructure/engines/browser-cookie-detector.ts';

export type ConfigurePayload = CommandPayload<'system.configure'>;

export function hostPlatform(value: NodeJS.Platform): HostPlatform {
  return value === 'win32' || value === 'darwin' ? value : 'linux';
}

export interface HostInfrastructure {
  readonly config: ConfigurePayload;
  readonly platform: HostPlatform;
  readonly homeDir: string;
  /** Directories whose paths must never leave the host (vault, per-job workspaces). */
  readonly sensitiveDirs: readonly string[];
  readonly logger: FileLogger;
  readonly persistence: SqlitePersistence;
  /** `disabled` when main could not load the vault key: the stores below then hold nothing. */
  readonly vault: VaultStatusDto;
  readonly cookieVault: CookieVault;
  readonly credentialVault: CredentialVault;
  readonly runner: ExecFileCommandRunner;
  readonly launcher: NodeProcessLauncher;
  readonly inspector: NodeProcessInspector;
  readonly terminator: NodeProcessTerminator;
  readonly sandbox: NodePathSandbox;
  readonly fileSystem: NodeFileSystem;
  readonly scanner: NodeLibraryScanner;
  readonly workspace: NodeJobWorkspace;
  readonly logReaders: NodeLogReaderFactory;
  readonly fileMarker: NodeFileMarker;
  readonly engineEnvironment: ScrubbedEngineEnvironment;
  readonly browserCookies: SystemBrowserCookieDetector;
}

type SecretStores = Pick<HostInfrastructure, 'vault' | 'cookieVault' | 'credentialVault'>;

/** Encrypted stores, or disabled ones (no key) so the rest of the host still starts. */
function createSecretStores(config: ConfigurePayload, logger: FileLogger): SecretStores {
  const { dataDir } = config.paths;
  if (config.vaultKey === null) {
    const reason = config.vaultUnavailable ?? 'io';
    logger.warn('secret vault disabled: main could not load its key', { reason });
    return {
      vault: { state: 'disabled', reason },
      cookieVault: new DisabledCookieVault(),
      credentialVault: new DisabledCredentialVault()
    };
  }
  const box = SecretBox.fromBase64(config.vaultKey);
  if (!box.ok) throw new AppError(box.error.code, box.error.params);
  return {
    vault: { state: 'ready' },
    cookieVault: new EncryptedCookieVault({ dataDir, box: box.value, logger }),
    credentialVault: new EncryptedCredentialVault({ dataDir, box: box.value, logger })
  };
}

export function createInfrastructure(config: ConfigurePayload): HostInfrastructure {
  const platform = hostPlatform(process.platform);
  const { paths } = config;
  const homeDir = os.homedir();
  const sensitiveDirs = [path.join(paths.dataDir, 'vault'), path.join(paths.dataDir, 'work')];

  const logger = new FileLogger({ logsDir: paths.logsDir, sensitiveDirs, mirrorToStderr: !config.isPackaged });
  logger.info('host configuring', { version: config.appVersion, platform, packaged: config.isPackaged });

  const persistence = createSqlitePersistence({ dataDir: paths.dataDir, platform, logger });
  const secrets = createSecretStores(config, logger);

  const runner = new ExecFileCommandRunner();
  const reader = new OsProcessIdentityReader({ platform, runner });
  const inspector = new NodeProcessInspector({ platform, reader });

  return {
    config,
    platform,
    homeDir,
    sensitiveDirs,
    logger,
    persistence,
    ...secrets,
    runner,
    launcher: new NodeProcessLauncher({ platform, reader }),
    inspector,
    terminator: new NodeProcessTerminator({ platform, inspector, runner, logger }),
    sandbox: new NodePathSandbox({
      // App data, managed tools and logs can never hold (or be inside) the download folder.
      protectedDirs: [...paths.protectedDirs, paths.dataDir, paths.runtimeDir, paths.logsDir],
      platform,
      homeDir,
      initialDownloadDir: config.defaultDownloadDir
    }),
    fileSystem: new NodeFileSystem({ platform }),
    scanner: new NodeLibraryScanner(),
    workspace: new NodeJobWorkspace({ dataDir: paths.dataDir, logger }),
    logReaders: new NodeLogReaderFactory(),
    fileMarker: new NodeFileMarker({ platform, runner, logger }),
    // Engine PATH = trusted directories only (same policy as tool discovery).
    engineEnvironment: new ScrubbedEngineEnvironment(
      process.env,
      platform,
      new DirectoryTrust({ platform, env: process.env, homeDir, uid: process.getuid?.() ?? null }),
      logger.child({ module: 'engine-env' })
    ),
    browserCookies: new SystemBrowserCookieDetector({ platform, env: process.env, homeDir, runner })
  };
}
