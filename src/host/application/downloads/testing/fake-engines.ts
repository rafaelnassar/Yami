/**
 * Fake engines: adapters whose parser reads JSON-encoded `ParsedLine`s (see `out`),
 * a tool registry, the engine environment and a browser-cookie detector.
 */
import type { EngineInfoDto } from '../../../../shared/contracts/dto.ts';
import type { Engine, ToolId } from '../../../../shared/domain/engine.ts';
import type { EngineErrorKind, ParsedLine } from '../../../domain/engines/parsed-line.ts';
import type {
  BrowserCookieDetector,
  EngineAdapter,
  EngineEnvironment,
  EngineRegistry,
  EngineSecrets,
  Invocation,
  InvocationContext,
  LineParser,
  ResolvedExecutable
} from '../../ports/engines.ts';
import type { ToolRegistry } from '../../ports/runtime.ts';

function isParsedLine(value: unknown): value is ParsedLine {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string';
}

/** Parses a line produced by `out.*`; anything else is an info line. */
export function parseFakeLine(line: string): ParsedLine {
  try {
    const value: unknown = JSON.parse(line);
    if (isParsedLine(value)) return value;
  } catch {
    // plain text
  }
  return { kind: 'info', level: 'info', text: line };
}

/** Scripted engine output lines. */
export const out = {
  file: (path: string): string => JSON.stringify({ kind: 'file', status: 'downloaded', path, text: `* ${path}` }),
  skipped: (path: string): string => JSON.stringify({ kind: 'file', status: 'skipped', path, text: `# ${path}` }),
  error: (message: string, errorKind: EngineErrorKind = 'unknown', fatal = true): string =>
    JSON.stringify({ kind: 'error', errorKind, message, fatal, text: `ERROR: ${message}` }),
  info: (text: string): string => JSON.stringify({ kind: 'info', level: 'info', text }),
  progress: (percent: number | null, speed: string | null = null, eta: string | null = null): string =>
    JSON.stringify({ kind: 'progress', percent, speed, eta }),
  pending: (path: string): string => JSON.stringify({ kind: 'pending-file', path, text: `Destination: ${path}` }),
  promote: (): string => JSON.stringify({ kind: 'promote-pending', text: '[download] 100%' }),
  noise: (): string => JSON.stringify({ kind: 'noise' })
} as const;

export class FakeEngineAdapter implements EngineAdapter {
  readonly engine: Engine;
  readonly slotWeight: number;
  readonly contexts: InvocationContext[] = [];
  readonly parsers: LineParser[] = [];

  constructor(engine: Engine, slotWeight: number) {
    this.engine = engine;
    this.slotWeight = slotWeight;
  }

  buildInvocation(context: InvocationContext): Invocation {
    this.contexts.push(context);
    const args = [...context.executable.prefixArgs];
    if (context.cookieFile) args.push('--cookies', context.cookieFile);
    if (context.browserCookies) args.push('--cookies-from-browser', context.browserCookies);
    if (context.secretConfigFile) args.push('--config', context.secretConfigFile);
    args.push('--destination', context.downloadDir, '--', context.url);
    return { executable: context.executable.path, args, env: { PYTHONUTF8: '1' } };
  }

  createParser(): LineParser {
    const parser: LineParser = { parse: parseFakeLine };
    this.parsers.push(parser);
    return parser;
  }

  secretConfig(url: string, secrets: EngineSecrets): { readonly fileName: string; readonly content: string } | null {
    const pixiv = secrets.siteCredentials.get('pixiv');
    const token = pixiv?.refreshToken ?? '';
    if (!url.includes('pixiv.net') || !token) return null;
    return { fileName: 'engine-secrets.conf', content: `extractor.pixiv.refresh-token=${token}` };
  }

  supportsBrowserCookies(): boolean {
    return this.engine === 'yt-dlp';
  }
}

export class FakeEngineRegistry implements EngineRegistry {
  readonly adapters: Record<Engine, FakeEngineAdapter> = {
    'gallery-dl': new FakeEngineAdapter('gallery-dl', 1),
    'yt-dlp': new FakeEngineAdapter('yt-dlp', 2)
  };

  get(engine: Engine): FakeEngineAdapter {
    return this.adapters[engine];
  }
}

export class FakeToolRegistry implements ToolRegistry {
  readonly missing = new Set<Engine>();

  resolveEngine(engine: Engine): ResolvedExecutable | null {
    return this.missing.has(engine) ? null : { path: `/opt/bin/${engine}`, prefixArgs: [] };
  }

  resolveHelper(tool: Extract<ToolId, 'ffmpeg' | 'deno'>): string | null {
    return `/opt/bin/${tool}`;
  }

  pathEntries(): readonly string[] {
    return ['/opt/bin'];
  }

  engines(): Readonly<Record<Engine, EngineInfoDto>> {
    const info = (engine: Engine): EngineInfoDto => ({
      engine,
      available: !this.missing.has(engine),
      version: '1.0',
      source: 'managed'
    });
    return { 'gallery-dl': info('gallery-dl'), 'yt-dlp': info('yt-dlp') };
  }
}

export const fakeEngineEnvironment: EngineEnvironment = {
  base: async (extraPathEntries) => ({ PATH: extraPathEntries.join(':'), HOME: '/home/test' })
};

export class FakeBrowserCookieDetector implements BrowserCookieDetector {
  browser: string | null = 'chrome';
  calls = 0;

  async detect(): Promise<string | null> {
    this.calls += 1;
    return this.browser;
  }
}
