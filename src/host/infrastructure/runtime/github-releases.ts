/**
 * `ReleasesApi` over the public GitHub REST API (unauthenticated: 60 requests/h per
 * IP, so the app only queries floating tools). Rate limits and offline errors
 * become `TOOLS_NETWORK_FAILED` with a short `detail` instead of silently looking
 * like "no update".
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { v } from '../../../shared/validation/schema.ts';
import type { ReleaseInfo, ReleasesApi } from '../../application/runtime/ports.ts';
import { getFollowingRedirects, header, HttpError, nodeHttpsGet, readBody, type HttpGet } from './https-client.ts';
import { classifyError } from './network-errors.ts';

export interface GithubReleasesOptions {
  readonly userAgent: string;
  readonly get?: HttpGet;
  readonly timeoutMs?: number;
  readonly apiBase?: string;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;

const ReleaseSchema = v.object(
  {
    tag_name: v.string({ min: 1, max: 200 }),
    assets: v.array(
      v.object(
        {
          name: v.string({ min: 1, max: 300 }),
          browser_download_url: v.httpUrl(),
          size: v.optional(v.nullable(v.number({ int: true, min: 0 })))
        },
        { strict: false }
      ),
      { max: 2_000 }
    )
  },
  { strict: false }
);

export class GithubReleases implements ReleasesApi {
  readonly #get: HttpGet;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #apiBase: string;

  constructor(options: GithubReleasesOptions) {
    this.#get = options.get ?? nodeHttpsGet;
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#apiBase = options.apiBase ?? 'https://api.github.com';
  }

  async latest(repo: string, signal: AbortSignal): Promise<Result<ReleaseInfo, AppErrorData>> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      return err({ code: ErrorCode.VALIDATION_FAILED, params: { detail: 'repo' } });
    }
    const body = await this.#fetch(repo, `${this.#apiBase}/repos/${repo}/releases/latest`, MAX_JSON_BYTES, signal, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    });
    if (!body.ok) return body;
    let json: unknown;
    try {
      json = JSON.parse(body.value);
    } catch {
      return err({ code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool: repo, detail: 'invalid JSON' } });
    }
    const parsed = ReleaseSchema.parse(json);
    if (!parsed.ok)
      return err({ code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool: repo, detail: 'unexpected response' } });
    return ok({
      repo,
      tag: parsed.value.tag_name,
      assets: parsed.value.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size ?? null }))
    });
  }

  fetchText(url: string, maxBytes: number, signal: AbortSignal): Promise<Result<string, AppErrorData>> {
    return this.#fetch('checksums', url, maxBytes, signal, { Accept: 'text/plain, application/octet-stream' });
  }

  async #fetch(
    label: string,
    url: string,
    maxBytes: number,
    signal: AbortSignal,
    headers: Record<string, string>
  ): Promise<Result<string, AppErrorData>> {
    try {
      const response = await getFollowingRedirects(this.#get, url, {
        headers: { 'User-Agent': this.#userAgent, ...headers },
        signal,
        timeoutMs: this.#timeoutMs
      });
      if (response.statusCode !== 200) {
        response.body.destroy();
        const limited =
          (response.statusCode === 403 || response.statusCode === 429) &&
          header(response.headers, 'x-ratelimit-remaining') === '0';
        if (limited)
          return err({ code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool: label, detail: 'rate-limited' } });
        throw new HttpError('http-status', response.statusCode);
      }
      const buffer = await readBody(response.body, maxBytes, this.#timeoutMs);
      return ok(buffer.toString('utf8'));
    } catch (error) {
      return err(classifyError(label, error, signal.aborted).error);
    }
  }
}
