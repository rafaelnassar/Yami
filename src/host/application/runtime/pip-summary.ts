/**
 * Turns raw pip output into short, localizable progress lines
 * (`runtimeProgress.pip*` codes). Noise (warnings, URLs, "already satisfied",
 * progress bars made of dashes) is dropped by returning `null`.
 */
import type { Params } from '../../../shared/contracts/dto.ts';

export interface PipSummary {
  readonly code: string;
  readonly params: Params;
  /** Percent of the pip step (0–100) or `null` when unknown. */
  readonly percent: number | null;
}

function packageName(token: string): string {
  // `yt_dlp-2025.11.12-py3-none-any.whl` / a full URL → `yt_dlp`
  const last = token.slice(token.lastIndexOf('/') + 1);
  return last
    .replace(/\.whl$/i, '')
    .replace(/[-_]?\d.*$/, '')
    .replace(/[[,].*$/, '')
    .trim();
}

export function summarizePipLine(line: string): PipSummary | null {
  // eslint-disable-next-line no-control-regex -- pip redraws its progress bar with backspaces; drop them
  const text = line.replace(/\u0008/g, '').trim();
  if (!text || /^[-.=\s]+$/.test(text)) return null;

  const fraction = /(\d+)\s*\/\s*(\d+)\s*\[([^\]]*)\]/.exec(text);
  if (fraction) {
    const current = Number(fraction[1]);
    const total = Number(fraction[2]);
    const pkg = (fraction[3] ?? '').replace(/[[\],].*$/, '').trim();
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
    return pkg
      ? { code: 'pipProgress', params: { package: pkg, current, total }, percent }
      : { code: 'pipProgressGeneric', params: { current, total }, percent };
  }

  const collecting = /^Collecting\s+(\S+)/i.exec(text);
  if (collecting?.[1]) {
    const name = collecting[1].replace(/[[,<>=!~;].*$/, '');
    return name ? { code: 'pipCollecting', params: { package: name }, percent: null } : null;
  }

  const downloading = /^Downloading\s+(\S+)/i.exec(text);
  if (downloading?.[1]) {
    const name = packageName(downloading[1]);
    return name
      ? { code: 'pipDownloading', params: { package: name }, percent: null }
      : { code: 'pipDownloadingGeneric', params: {}, percent: null };
  }

  if (/^Installing collected packages/i.test(text))
    return { code: 'pipInstallingCollected', params: {}, percent: null };
  if (/^Successfully installed/i.test(text)) return { code: 'pipDone', params: {}, percent: 100 };
  return null;
}
