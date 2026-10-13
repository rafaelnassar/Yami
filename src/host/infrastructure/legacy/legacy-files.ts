/**
 * Tolerant readers for the legacy JSON files (`state.json`, spec 02 §5.2, and
 * `credentials.json`, spec 02 §6.5). Missing, oversized or corrupt files read
 * as "nothing to import"; individual invalid entries are dropped.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { v, type Infer, type Schema } from '../../../shared/validation/schema.ts';
import { DOWNLOAD_SCOPES, ENGINES, RUNTIME_MODES } from '../../../shared/domain/engine.ts';
import { DOWNLOAD_STATUSES } from '../../../shared/contracts/dto.ts';

/** Legacy plaintext Pixiv credentials, relative to the legacy dir. */
export const LEGACY_CREDENTIALS_FILE = 'credentials.json';

const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_CREDENTIALS_BYTES = 1024 * 1024;

const text = v.string({ max: 100_000, noControlChars: false });
const timestamp = v.number({ min: 0 });
const count = v.number({ int: true, min: 0 });

const JobSchema = v.object(
  {
    id: v.id(),
    batchId: v.optional(v.nullable(v.id())),
    url: v.httpUrl(),
    engine: v.enum(ENGINES),
    scope: v.optional(v.enum(DOWNLOAD_SCOPES)),
    cookiesPath: v.optional(v.nullable(text)),
    status: v.enum(DOWNLOAD_STATUSES),
    createdAt: v.optional(v.nullable(timestamp)),
    startedAt: v.optional(v.nullable(timestamp)),
    stats: v.optional(v.object({ done: count, skipped: count, errors: count }, { strict: false }))
  },
  { strict: false }
);

const BatchSchema = v.object(
  {
    id: v.id(),
    total: count,
    engine: v.enum(ENGINES),
    scope: v.optional(v.string({ max: 32 })),
    createdAt: timestamp,
    finalNotifiedAt: v.optional(v.nullable(timestamp))
  },
  { strict: false }
);

export type LegacyJob = Infer<typeof JobSchema>;
export type LegacyStateBatch = Infer<typeof BatchSchema>;

export interface LegacyConfig {
  readonly engine: (typeof ENGINES)[number] | null;
  readonly downloadDir: string | null;
  readonly cookiesPath: string | null;
  readonly cookiesFromBrowser: boolean;
  readonly runtimeMode: (typeof RUNTIME_MODES)[number] | null;
  readonly setupDismissed: boolean;
}

export interface LegacyState {
  readonly jobs: readonly LegacyJob[];
  readonly batches: ReadonlyMap<string, LegacyStateBatch>;
  readonly config: LegacyConfig | null;
  readonly invalidEntries: number;
}

export interface LegacyPixiv {
  readonly refreshToken: string;
  readonly userName: string | null;
  readonly userId: string | null;
  readonly updatedAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(file: string, maxBytes: number): Promise<unknown> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > maxBytes) return undefined;
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw);
  } catch {
    return undefined;
  }
}

function parseConfig(raw: unknown): LegacyConfig | null {
  if (!isRecord(raw)) return null;
  const pick = <T>(schema: Schema<T>, value: unknown): T | null => {
    const parsed = schema.parse(value);
    return parsed.ok ? parsed.value : null;
  };
  return {
    engine: pick(v.enum(ENGINES), raw['engine']),
    downloadDir: pick(v.string({ min: 1, max: 32_767, trim: true }), raw['downloadDir']),
    cookiesPath: pick(v.string({ min: 1, max: 32_767 }), raw['cookiesPath']),
    cookiesFromBrowser: raw['cookiesFromBrowser'] === true,
    runtimeMode: pick(v.enum(RUNTIME_MODES), raw['runtimeMode']),
    setupDismissed: raw['setupDismissed'] === true
  };
}

/** `null` when `state.json` is missing or unusable (legacy accepted it only with a `jobs` array). */
export async function readLegacyState(legacyDir: string): Promise<LegacyState | null> {
  const raw = await readJson(path.join(legacyDir, 'state.json'), MAX_STATE_BYTES);
  if (!isRecord(raw) || !Array.isArray(raw['jobs'])) return null;
  let invalidEntries = 0;
  const jobs: LegacyJob[] = [];
  for (const entry of raw['jobs']) {
    const parsed = JobSchema.parse(entry);
    if (parsed.ok) jobs.push(parsed.value);
    else invalidEntries += 1;
  }
  const batches = new Map<string, LegacyStateBatch>();
  if (isRecord(raw['batches'])) {
    for (const entry of Object.values(raw['batches'])) {
      const parsed = BatchSchema.parse(entry);
      if (parsed.ok) batches.set(parsed.value.id, parsed.value);
      else invalidEntries += 1;
    }
  }
  return { jobs, batches, config: parseConfig(raw['config']), invalidEntries };
}

/** Pixiv credentials from `credentials.json`, or `null`. */
export async function readLegacyPixiv(legacyDir: string): Promise<LegacyPixiv | null> {
  const raw = await readJson(path.join(legacyDir, LEGACY_CREDENTIALS_FILE), MAX_CREDENTIALS_BYTES);
  if (!isRecord(raw) || !isRecord(raw['pixiv'])) return null;
  const entry = raw['pixiv'];
  const token = typeof entry['refreshToken'] === 'string' ? entry['refreshToken'].trim() : '';
  if (!token || token.length > 4_096) return null;
  const userName = typeof entry['userName'] === 'string' ? entry['userName'].trim().slice(0, 256) : '';
  const rawId = entry['userId'];
  const userId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim().slice(0, 64) : '';
  const updatedAt = entry['updatedAt'];
  return {
    refreshToken: token,
    userName: userName || null,
    userId: userId || null,
    updatedAt:
      typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0 ? Math.trunc(updatedAt) : null
  };
}
