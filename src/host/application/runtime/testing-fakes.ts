/**
 * In-memory fakes of the runtime ports (test support only — imported by
 * `*.test.ts` files, never by production code).
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import type { Engine, RuntimeMode, ToolId } from '../../../shared/domain/engine.ts';
import type { HostEvent } from '../../../shared/contracts/host-protocol.ts';
import { DEFAULT_HOST_SETTINGS, type HostSettings, type HostSettingsRepository } from '../ports/persistence.ts';
import type { EventSink, LogFields, Logger } from '../ports/system.ts';
import type {
  ArchiveExtractor,
  Downloader,
  DownloadedFile,
  DownloadRequest,
  InstalledToolMeta,
  InstallExecutableRequest,
  InstallPythonRequest,
  PipInstallRequest,
  PipRunner,
  ProbedTool,
  ProbeSnapshot,
  ReleaseInfo,
  ReleasesApi,
  Staging,
  ToolInstaller,
  ToolProbe
} from './ports.ts';

export class FakeLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields });
  }
  child(): Logger {
    return this;
  }
}

export class FakeEvents implements EventSink {
  readonly events: HostEvent[] = [];
  publish(event: HostEvent): void {
    this.events.push(event);
  }
  ofType<T extends HostEvent['type']>(type: T): Array<Extract<HostEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<HostEvent, { type: T }> => e.type === type);
  }
}

export class FakeSettings implements HostSettingsRepository {
  current: HostSettings;
  saves = 0;
  constructor(initial: Partial<HostSettings> = {}) {
    this.current = { ...DEFAULT_HOST_SETTINGS, ...initial };
  }
  load(): HostSettings {
    return this.current;
  }
  save(settings: HostSettings): void {
    this.saves += 1;
    this.current = settings;
  }
}

export function probed(
  path: string,
  source: ProbedTool['source'],
  rawVersion: string | null,
  prefixArgs: string[] = []
): ProbedTool {
  return { path, directory: path.slice(0, path.lastIndexOf('/')) || '/', source, rawVersion, prefixArgs };
}

/** Executables by tool + python modules (python mode engines). */
export class FakeProbe implements ToolProbe {
  readonly tools = new Map<ToolId, ProbedTool>();
  readonly modules = new Map<Engine, ProbedTool>();
  readonly calls: RuntimeMode[] = [];

  async probe(mode: RuntimeMode): Promise<ProbeSnapshot> {
    this.calls.push(mode);
    const pick = (tool: ToolId): ProbedTool | null => {
      if (mode === 'python' && (tool === 'gallery-dl' || tool === 'yt-dlp')) return this.modules.get(tool) ?? null;
      return this.tools.get(tool) ?? null;
    };
    return {
      tools: {
        'gallery-dl': pick('gallery-dl'),
        'yt-dlp': pick('yt-dlp'),
        deno: pick('deno'),
        ffmpeg: pick('ffmpeg'),
        python: pick('python')
      },
      managedBinDir: '/rt/bin'
    };
  }
}

/** Resolves each download with the SHA-256 configured for its URL (or a fixed default). */
export class FakeDownloader implements Downloader {
  readonly requests: DownloadRequest[] = [];
  readonly shaByUrl = new Map<string, string>();
  defaultSha = '0'.repeat(64);
  failWith: AppErrorData | null = null;
  /** When set, downloads wait for `release()` (or abort). */
  gate: Promise<void> | null = null;
  #open: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open?.();
    this.gate = null;
  }

  async download(request: DownloadRequest): Promise<Result<DownloadedFile, AppErrorData>> {
    this.requests.push(request);
    request.onProgress?.(0, 100);
    request.onProgress?.(50, 100);
    if (this.gate) {
      const aborted = new Promise<'aborted'>((resolve) =>
        request.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      );
      if ((await Promise.race([this.gate.then(() => 'open' as const), aborted])) === 'aborted')
        return err({ code: ErrorCode.CANCELLED });
    }
    if (this.failWith) return err(this.failWith);
    request.onProgress?.(100, 100);
    return ok({ bytes: 100, sha256: this.shaByUrl.get(request.url) ?? this.defaultSha });
  }
}

export class FakeExtractor implements ArchiveExtractor {
  readonly calls: string[] = [];
  async extract(tool: ToolId): Promise<Result<void, AppErrorData>> {
    this.calls.push(tool);
    return ok();
  }
}

/** Records installs and makes the fake probe see the tool as managed afterwards. */
export class FakeInstaller implements ToolInstaller {
  readonly metas = new Map<ToolId, InstalledToolMeta>();
  readonly executables: InstallExecutableRequest[] = [];
  readonly pythons: InstallPythonRequest[] = [];
  readonly released: Staging[] = [];
  prepared = 0;
  readonly #probe: FakeProbe;
  constructor(probe: FakeProbe) {
    this.#probe = probe;
  }
  async prepare(): Promise<void> {
    this.prepared += 1;
  }
  async stage(tool: ToolId): Promise<Staging> {
    return { downloadPath: `/rt/.tmp/${tool}.download`, extractDir: `/rt/.tmp/${tool}-extract` };
  }
  async release(staging: Staging): Promise<void> {
    this.released.push(staging);
  }
  async installExecutable(request: InstallExecutableRequest): Promise<Result<{ readonly path: string }, AppErrorData>> {
    this.executables.push(request);
    this.metas.set(request.tool, request.meta);
    const path = `/rt/bin/${request.tool}`;
    this.#probe.tools.set(request.tool, probed(path, 'managed', request.meta.version));
    return ok({ path });
  }
  /** Like the real installer: `beforeSwap` runs on the staged copy; a failure installs nothing. */
  async installPython(request: InstallPythonRequest): Promise<Result<{ readonly executable: string }, AppErrorData>> {
    const staged = `${request.staging.extractDir}/${request.entry}`;
    const prepared = request.beforeSwap ? await request.beforeSwap(staged) : ok();
    if (!prepared.ok) return prepared;
    this.pythons.push(request);
    this.metas.set('python', request.meta);
    const executable = '/rt/python/bin/python3';
    this.#probe.tools.set('python', probed(executable, 'managed', `Python ${request.meta.version}`));
    // The swap replaces the distribution: modules installed into the staged copy move with it, the old ones go.
    for (const [engine, module] of [...this.#probe.modules]) {
      if (module.path === staged)
        this.#probe.modules.set(engine, probed(executable, module.source, module.rawVersion, [...module.prefixArgs]));
      else if (module.path === executable) this.#probe.modules.delete(engine);
    }
    return ok({ executable });
  }
  async readMeta(tool: ToolId): Promise<InstalledToolMeta | null> {
    return this.metas.get(tool) ?? null;
  }
}

export class FakePip implements PipRunner {
  readonly calls: Array<{ python: string; requirements: readonly string[]; lock: PipInstallRequest['lock'] }> = [];
  lines: string[] = ['Collecting yt-dlp[default]==2025.11.12', '2/4 [yt-dlp]', 'Successfully installed yt-dlp'];
  failWith: AppErrorData | null = null;
  readonly #probe: FakeProbe;
  constructor(probe: FakeProbe) {
    this.#probe = probe;
  }
  async install(
    python: string,
    request: PipInstallRequest,
    onLine: (line: string) => void
  ): Promise<Result<void, AppErrorData>> {
    const { requirements, lock } = request;
    this.calls.push({ python, requirements, lock });
    for (const line of this.lines) onLine(line);
    if (this.failWith) return err(this.failWith);
    for (const requirement of requirements) {
      const [name, version = ''] = requirement.split('==');
      const engine: Engine = name?.startsWith('yt-dlp') ? 'yt-dlp' : 'gallery-dl';
      this.#probe.modules.set(
        engine,
        probed(python, 'python', version, ['-m', engine === 'yt-dlp' ? 'yt_dlp' : 'gallery_dl'])
      );
    }
    return ok();
  }
}

export class FakeReleases implements ReleasesApi {
  latestResult: Result<ReleaseInfo, AppErrorData> = err({
    code: ErrorCode.TOOLS_NETWORK_FAILED,
    params: { detail: 'offline' }
  });
  texts = new Map<string, string>();
  readonly latestCalls: string[] = [];
  async latest(repo: string): Promise<Result<ReleaseInfo, AppErrorData>> {
    this.latestCalls.push(repo);
    return this.latestResult;
  }
  async fetchText(url: string): Promise<Result<string, AppErrorData>> {
    const text = this.texts.get(url);
    return text === undefined
      ? err({ code: ErrorCode.TOOLS_NETWORK_FAILED, params: { detail: 'HTTP 404' } })
      : ok(text);
  }
}

export class ManualClock {
  value = 1_000;
  now(): number {
    return this.value;
  }
}

/** Polls until `predicate` holds (fakes resolve on microtasks/timers). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
