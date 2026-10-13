/** `EngineAdapter` for yt-dlp (videos, audio, playlists). */
import type {
  EngineAdapter,
  Invocation,
  InvocationContext,
  LineParser,
  ParserContext
} from '../../../application/ports/engines.ts';
import type { Engine } from '../../../../shared/domain/engine.ts';
import { isHttpUrl } from '../../../../shared/domain/url.ts';
import { normalizeBrowserCookieSpec } from '../browser-cookie-spec.ts';
import { ENGINE_UTF8_ENV } from '../engine-environment.ts';
import { buildYtDlpArgs } from './yt-dlp-args.ts';
import { YtDlpLineParser } from './yt-dlp-parser.ts';

export class YtDlpAdapter implements EngineAdapter {
  readonly engine: Engine = 'yt-dlp';
  /** Heavy on CPU/network: counts double against the slot budget. */
  readonly slotWeight = 2;

  buildInvocation(context: InvocationContext): Invocation {
    const browserCookies = this.supportsBrowserCookies(context.url)
      ? normalizeBrowserCookieSpec(context.browserCookies)
      : null;
    const engineArgs = buildYtDlpArgs({
      url: context.url,
      downloadDir: context.downloadDir,
      tempDir: context.tempDir,
      ffmpegPath: context.ffmpegPath,
      denoPath: context.denoPath,
      cookieFile: context.cookieFile,
      browserCookies
    });
    return {
      executable: context.executable.path,
      args: [...context.executable.prefixArgs, ...engineArgs],
      env: { ...ENGINE_UTF8_ENV }
    };
  }

  /** `context.downloadDir`/`tempDir` bound which printed paths may be reported as files. */
  createParser(context?: ParserContext): LineParser {
    return new YtDlpLineParser(context);
  }

  /** yt-dlp needs no private config: credentials travel as cookie files. */
  secretConfig(): null {
    return null;
  }

  /** Browser cookies apply to every site (the opt-in/retry policy lives in the downloads core). */
  supportsBrowserCookies(url: string): boolean {
    return isHttpUrl(url);
  }
}
