/** `EngineAdapter` for gallery-dl (images, albums, collections). */
import type {
  EngineAdapter,
  EngineSecrets,
  Invocation,
  InvocationContext,
  LineParser,
  ParserContext
} from '../../../application/ports/engines.ts';
import type { Engine } from '../../../../shared/domain/engine.ts';
import { ENGINE_UTF8_ENV } from '../engine-environment.ts';
import { buildGalleryDlArgs } from './gallery-dl-args.ts';
import { buildGalleryDlSecretConfig } from './gallery-dl-secret-config.ts';
import { GalleryDlLineParser } from './gallery-dl-parser.ts';

export const GALLERY_DL_SECRET_CONFIG_FILE = 'gallery-dl-secrets.json';

export interface GalleryDlAdapterOptions {
  /**
   * Whether gallery-dl may hand Reddit/Fanbox/Facebook videos to its `ytdl`
   * downloader. That downloader imports the `yt_dlp` Python module, which a
   * standalone gallery-dl build may lack (spec 03 Q7), so the composition root
   * decides. Evaluated per invocation. Default: never.
   */
  readonly delegateVideosToYtdl?: () => boolean;
}

export class GalleryDlAdapter implements EngineAdapter {
  readonly engine: Engine = 'gallery-dl';
  /** Many light HTTP requests: counts once against the slot budget. */
  readonly slotWeight = 1;
  readonly #delegateVideosToYtdl: () => boolean;

  constructor(options: GalleryDlAdapterOptions = {}) {
    this.#delegateVideosToYtdl = options.delegateVideosToYtdl ?? (() => false);
  }

  buildInvocation(context: InvocationContext): Invocation {
    const engineArgs = buildGalleryDlArgs({
      url: context.url,
      downloadDir: context.downloadDir,
      secretDir: context.secretDir ?? null,
      platform: context.platform,
      cookieFile: context.cookieFile,
      secretConfigFile: context.secretConfigFile,
      delegateVideosToYtdl: this.#delegateVideosToYtdl()
    });
    return {
      executable: context.executable.path,
      args: [...context.executable.prefixArgs, ...engineArgs],
      env: { ...ENGINE_UTF8_ENV }
    };
  }

  /** `context.downloadDir` bounds which printed paths may be reported as files. */
  createParser(context?: ParserContext): LineParser {
    return new GalleryDlLineParser(context);
  }

  /**
   * Pixiv App URLs need the OAuth refresh token. It goes into a private config file
   * (never argv, where other local processes could read it — Q22), under the long
   * `extractor.` key (the short form is ignored by gallery-dl). `pixiv-novel` is
   * the category newer gallery-dl versions use for novels; unknown keys are ignored.
   */
  secretConfig(url: string, secrets: EngineSecrets): { readonly fileName: string; readonly content: string } | null {
    const config = buildGalleryDlSecretConfig(url, secrets.siteCredentials);
    if (!config) return null;
    return {
      fileName: GALLERY_DL_SECRET_CONFIG_FILE,
      content: JSON.stringify(config)
    };
  }

  /** Browser cookie extraction is a yt-dlp feature in this app. */
  supportsBrowserCookies(): boolean {
    return false;
  }
}
