/** Download engines and runtime tool identifiers shared by every process. */

export const ENGINES = ['gallery-dl', 'yt-dlp'] as const;
export type Engine = (typeof ENGINES)[number];

export function isEngine(value: unknown): value is Engine {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}

export const DOWNLOAD_SCOPES = ['single', 'bulk'] as const;
export type DownloadScope = (typeof DOWNLOAD_SCOPES)[number];

export const TOOL_IDS = ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const RUNTIME_MODES = ['standalone', 'python'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** Where a tool binary was found. */
export const TOOL_SOURCES = ['managed', 'system', 'python', 'env', 'none'] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];
