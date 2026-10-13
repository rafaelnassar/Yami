/**
 * Prepares and spawns one engine run: job workspace, cookie file, private secret
 * config, browser cookies, invocation, scrubbed environment, detached process.
 * Failures are returned as a launch-failure reason; the caller finishes the
 * download as failed.
 *
 * Runs OUTSIDE the downloads mutex (it awaits the vault, the browser detector and
 * the OS), so it only reads an immutable `LaunchTarget` snapshot of the download.
 */
import { ErrorCode, isAppErrorData } from '../../../shared/kernel/errors.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { DownloadState } from '../../domain/downloads/download-state.ts';
import { OUTCOME_REASONS, type LaunchFailureReason } from '../../domain/downloads/outcome-policy.ts';
import type {
  BrowserCookieDetector,
  EngineAdapter,
  EngineEnvironment,
  EngineRegistry,
  HostPlatform,
  ResolvedExecutable
} from '../ports/engines.ts';
import type { JobPaths, JobWorkspace, LogReaderFactory, PathSandbox } from '../ports/files.ts';
import type { HostSettingsRepository } from '../ports/persistence.ts';
import type { LaunchedProcess, ProcessLauncher } from '../ports/processes.ts';
import type { ToolRegistry } from '../ports/runtime.ts';
import type { CookieVault, CredentialVault, SiteCredentials } from '../ports/secrets.ts';
import type { Logger } from '../ports/system.ts';
import type { CookieResolver } from './cookie-resolver.ts';
import type { ActiveRun, MaterializedCookie } from './download-registry.ts';
import type { DownloadJournal } from './journal.ts';
import type { OutputPaths } from './output-paths.ts';
import type { Redactor } from './redactor.ts';

/** What a launch needs from the download (a snapshot taken under the mutex). */
export type LaunchTarget = Pick<DownloadState, 'id' | 'engine' | 'sourceUrl' | 'cookieName' | 'retry'>;

export interface LaunchFailure {
  readonly reason: LaunchFailureReason;
  /** Redacted technical detail, when useful. */
  readonly detail: string | null;
}

export interface LaunchSuccess {
  readonly run: ActiveRun;
  readonly process: LaunchedProcess;
  readonly logFile: string;
  readonly usedBrowserCookies: boolean;
}

export interface LaunchServiceDeps {
  readonly engines: EngineRegistry;
  readonly tools: ToolRegistry;
  readonly engineEnvironment: EngineEnvironment;
  readonly launcher: ProcessLauncher;
  readonly logReaders: LogReaderFactory;
  readonly workspace: JobWorkspace;
  readonly cookieVault: CookieVault;
  readonly credentialVault: CredentialVault;
  readonly browserCookies: BrowserCookieDetector;
  readonly sandbox: PathSandbox;
  readonly settings: HostSettingsRepository;
  readonly cookieResolver: CookieResolver;
  readonly journal: DownloadJournal;
  readonly redactor: Redactor;
  readonly paths: OutputPaths;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly platform: HostPlatform;
}

interface RunSecrets {
  readonly cookie: MaterializedCookie | null;
  readonly secretConfigFile: string | null;
  readonly browserCookies: string | null;
}

export class LaunchService {
  readonly #deps: LaunchServiceDeps;

  constructor(deps: LaunchServiceDeps) {
    this.#deps = deps;
  }

  async launch(download: LaunchTarget): Promise<Result<LaunchSuccess, LaunchFailure>> {
    const { tools, engines, workspace } = this.#deps;
    const executable = tools.resolveEngine(download.engine);
    if (!executable) return err({ reason: OUTCOME_REASONS.engineMissing, detail: null });
    const adapter = engines.get(download.engine);

    let paths: JobPaths;
    try {
      paths = await workspace.prepare(download.id);
    } catch (error) {
      return err({ reason: OUTCOME_REASONS.workspaceFailed, detail: this.#describe(error) });
    }

    const result = await this.#spawn(download, adapter, paths, executable);
    // Temp files stay: a paused download continues them; a failed one is retired when it finishes.
    if (!result.ok) await this.#removeSecrets(download.id);
    return result;
  }

  async #spawn(
    download: LaunchTarget,
    adapter: EngineAdapter,
    paths: JobPaths,
    executable: ResolvedExecutable
  ): Promise<Result<LaunchSuccess, LaunchFailure>> {
    const { tools, sandbox, engineEnvironment, launcher, workspace, journal, redactor, logReaders, clock } = this.#deps;
    const secrets = await this.#prepareSecrets(download, adapter, paths);
    if (!secrets.ok) return secrets;
    const { cookie, secretConfigFile, browserCookies } = secrets.value;
    const downloadDir = sandbox.downloadDir;
    const engineDir = this.#deps.paths.engineDir(downloadDir, download.engine);
    try {
      const invocation = adapter.buildInvocation({
        url: download.sourceUrl,
        downloadDir: engineDir,
        tempDir: paths.tempDir,
        secretDir: paths.dir,
        executable,
        ffmpegPath: tools.resolveHelper('ffmpeg'),
        denoPath: tools.resolveHelper('deno'),
        cookieFile: cookie?.file ?? null,
        browserCookies,
        secretConfigFile,
        platform: this.#deps.platform
      });
      const env = { ...(await engineEnvironment.base(tools.pathEntries())), ...invocation.env };
      journal.logText('cmd', redactor.commandLine(invocation.executable, invocation.args), download.id);
      const launched = await launcher.launch({
        executable: invocation.executable,
        args: invocation.args,
        env,
        cwd: workspace.processCwd,
        logFile: paths.logFile
      });
      if (!launched.ok) return err({ reason: OUTCOME_REASONS.spawnFailed, detail: this.#describe(launched.error) });
      const run: ActiveRun = {
        downloadId: download.id,
        reader: logReaders.open(paths.logFile, 0),
        parser: adapter.createParser({ tempDir: paths.tempDir, downloadDir: engineDir }),
        launchedHere: true,
        downloadDir,
        outputDir: engineDir,
        tempDir: paths.tempDir,
        cookie,
        exit: null,
        stalePolls: 0,
        lastPersistAt: clock.now(),
        persistedOffset: 0
      };
      return ok({ run, process: launched.value, logFile: paths.logFile, usedBrowserCookies: browserCookies !== null });
    } catch (error) {
      return err({ reason: OUTCOME_REASONS.spawnFailed, detail: this.#describe(error) });
    }
  }

  async #prepareSecrets(
    download: LaunchTarget,
    adapter: EngineAdapter,
    paths: JobPaths
  ): Promise<Result<RunSecrets, LaunchFailure>> {
    const { cookieResolver, cookieVault, workspace } = this.#deps;
    const cookieName = await cookieResolver.resolve(download);
    let cookie: MaterializedCookie | null = null;
    if (cookieName) {
      const materialized = await cookieVault.materialize(cookieName, paths.dir).catch(() => null);
      if (!materialized?.ok) {
        // A disabled vault gets its own reason: the file exists, the key to read it does not.
        const vaultDown = materialized?.error.code === ErrorCode.VAULT_UNAVAILABLE;
        return err({
          reason: vaultDown ? OUTCOME_REASONS.vaultUnavailable : OUTCOME_REASONS.cookiesUnavailable,
          detail: cookieName
        });
      }
      cookie = { name: cookieName, file: materialized.value };
    }

    let secretConfigFile: string | null = null;
    const config = adapter.secretConfig(download.sourceUrl, {
      siteCredentials: await this.#siteCredentials()
    });
    if (config) {
      try {
        secretConfigFile = await workspace.writePrivateFile(download.id, config.fileName, config.content);
      } catch (error) {
        return err({ reason: OUTCOME_REASONS.workspaceFailed, detail: this.#describe(error) });
      }
    }

    const browserCookies = cookie ? null : await this.#browserCookies(download, adapter);
    return ok({ cookie, secretConfigFile, browserCookies });
  }

  /**
   * yt-dlp only, and ONLY with the user opt-in: nothing else (retry mode, engine
   * output) may make the app read the browser's cookie store. The `skip` retry mode
   * turns them off for a run; `force` just retries with the opt-in honored.
   */
  async #browserCookies(download: LaunchTarget, adapter: EngineAdapter): Promise<string | null> {
    if (!adapter.supportsBrowserCookies(download.sourceUrl)) return null;
    if (download.retry.browserCookieMode === 'skip' || !this.#optIn()) return null;
    try {
      return await this.#deps.browserCookies.detect();
    } catch (error) {
      this.#deps.logger.warn('browser cookie detection failed', { error: String(error) });
      return null;
    }
  }

  #optIn(): boolean {
    try {
      return this.#deps.settings.load().cookies.fromBrowser;
    } catch (error) {
      this.#deps.logger.warn('settings unavailable; browser cookies disabled', { error: String(error) });
      return false;
    }
  }

  async #siteCredentials(): Promise<ReadonlyMap<string, SiteCredentials>> {
    try {
      return await this.#deps.credentialVault.getAllSites();
    } catch (error) {
      this.#deps.logger.warn('credential vault unavailable', { error: String(error) });
      return new Map();
    }
  }

  async #removeSecrets(downloadId: string): Promise<void> {
    try {
      await this.#deps.workspace.removeSecrets(downloadId);
    } catch (error) {
      this.#deps.logger.warn('job workspace cleanup failed', { downloadId, error: String(error) });
    }
  }

  #describe(error: unknown): string {
    if (isAppErrorData(error)) {
      const detail = error.params?.['detail'];
      return this.#deps.redactor.text(typeof detail === 'string' && detail ? detail : error.code);
    }
    return this.#deps.redactor.text(error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
}
