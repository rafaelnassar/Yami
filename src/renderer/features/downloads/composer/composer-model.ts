/** Pure composer rules: batch parsing/validation and greeting rotation. */
import { isHttpUrl } from '../../../../shared/domain/url.ts';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';

/** Unique, trimmed, non-empty lines. */
export function linesFrom(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ];
}

export interface BatchCheck {
  readonly urls: readonly string[];
  readonly invalid: number;
  readonly overLimit: boolean;
}

export function checkBatch(value: string): BatchCheck {
  const urls = linesFrom(value);
  const invalid = urls.filter((url) => !isHttpUrl(url)).length;
  return { urls, invalid, overLimit: urls.length > LIMITS.maxUrlsPerBatch };
}

export function canSubmitBatch(check: BatchCheck): boolean {
  return check.urls.length > 0 && check.invalid === 0 && !check.overLimit;
}

/** Appends clipboard URLs to a batch draft (one per line, no duplicates). */
export function appendToBatch(draft: string, urls: readonly string[]): string {
  const existing = linesFrom(draft);
  const merged = [...existing, ...urls.filter((url) => !existing.includes(url))];
  return merged.join('\n');
}

/** Random greeting different from `exclude` (when possible). */
export function pickGreeting(
  options: readonly string[],
  exclude: string | null,
  random: () => number = Math.random
): string {
  const pool = exclude ? options.filter((item) => item !== exclude) : options;
  const list = pool.length > 0 ? pool : options;
  return list[Math.floor(random() * list.length)] ?? options[0] ?? '';
}
