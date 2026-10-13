/**
 * `settings` table: `HostSettings` under key `host` plus internal markers
 * (e.g. the legacy-import marker) under `marker:<name>`.
 * `load()` validates field by field so one bad value never discards the rest.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { v, type Schema } from '../../../shared/validation/schema.ts';
import { ENGINES, RUNTIME_MODES, TOOL_IDS, type ToolId } from '../../../shared/domain/engine.ts';
import type { CookieBindingDto } from '../../../shared/contracts/dto.ts';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import {
  DEFAULT_HOST_SETTINGS,
  type HostSettings,
  type HostSettingsRepository
} from '../../application/ports/persistence.ts';
import type { Logger } from '../../application/ports/system.ts';

const HOST_KEY = 'host';
const MARKER_PREFIX = 'marker:';

const cookieName = v.string({ min: 1, max: 128, pattern: /^[\w.@()+ -]+\.txt$/ });
const BindingSchema = v.object(
  {
    id: v.id(),
    siteHost: v.string({ min: 1, max: 253, pattern: /^[a-z0-9.-]+$/i }),
    cookieName
  },
  { strict: false }
);
const TOOL_ID_SET = new Set<string>(TOOL_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field<T>(source: Record<string, unknown>, key: string, schema: Schema<T>, fallback: T): T {
  if (!(key in source)) return fallback;
  const parsed = schema.parse(source[key]);
  return parsed.ok ? parsed.value : fallback;
}

function bindingsOf(raw: unknown): CookieBindingDto[] {
  if (!Array.isArray(raw)) return [];
  const out: CookieBindingDto[] = [];
  for (const item of raw) {
    const parsed = BindingSchema.parse(item);
    if (parsed.ok) out.push(parsed.value);
    if (out.length >= LIMITS.maxCookieBindings) break;
  }
  return out;
}

function latestOf(raw: unknown): Partial<Record<ToolId, string>> {
  const out: Partial<Record<ToolId, string>> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!TOOL_ID_SET.has(key) || typeof value !== 'string') continue;
    const version = value.trim();
    if (version && version.length <= 64) out[key as ToolId] = version;
  }
  return out;
}

/** Merges stored (untrusted) values over the defaults. */
export function mergeHostSettings(raw: unknown): HostSettings {
  const d = DEFAULT_HOST_SETTINGS;
  if (!isRecord(raw)) return d;
  const cookies = isRecord(raw['cookies']) ? raw['cookies'] : {};
  const toolUpdates = isRecord(raw['toolUpdates']) ? raw['toolUpdates'] : {};
  return {
    downloadDir: field(raw, 'downloadDir', v.nullable(v.fsPath()), d.downloadDir),
    defaultEngine: field(raw, 'defaultEngine', v.enum(ENGINES), d.defaultEngine),
    runtimeMode: field(raw, 'runtimeMode', v.enum(RUNTIME_MODES), d.runtimeMode),
    setupDismissed: field(raw, 'setupDismissed', v.boolean(), d.setupDismissed),
    cookies: {
      active: field(cookies, 'active', v.nullable(cookieName), d.cookies.active),
      fromBrowser: field(cookies, 'fromBrowser', v.boolean(), d.cookies.fromBrowser),
      bindings: bindingsOf(cookies['bindings'])
    },
    toolUpdates: {
      checkedAt: field(toolUpdates, 'checkedAt', v.nullable(v.number({ int: true, min: 0 })), d.toolUpdates.checkedAt),
      latest: latestOf(toolUpdates['latest'])
    }
  };
}

/** Key/value markers for host bookkeeping that is not part of `HostSettings`. */
export interface InternalMarkers {
  get(name: string): number | null;
  set(name: string, value: number): void;
  delete(name: string): void;
}

export class SqliteSettingsStore implements HostSettingsRepository, InternalMarkers {
  readonly #logger: Logger;
  readonly #read: StatementSync;
  readonly #write: StatementSync;
  readonly #remove: StatementSync;

  constructor(db: DatabaseSync, logger: Logger) {
    this.#logger = logger;
    this.#read = db.prepare('SELECT value FROM settings WHERE key = ?');
    this.#write = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    this.#remove = db.prepare('DELETE FROM settings WHERE key = ?');
  }

  load(): HostSettings {
    return mergeHostSettings(this.#readJson(HOST_KEY));
  }

  save(settings: HostSettings): void {
    this.#write.run(HOST_KEY, JSON.stringify(settings));
  }

  get(name: string): number | null {
    const value = this.#readJson(MARKER_PREFIX + name);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  set(name: string, value: number): void {
    this.#write.run(MARKER_PREFIX + name, JSON.stringify(value));
  }

  delete(name: string): void {
    this.#remove.run(MARKER_PREFIX + name);
  }

  #readJson(key: string): unknown {
    const raw = this.#read.get(key)?.['value'];
    if (typeof raw !== 'string') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      this.#logger.warn('ignoring corrupted setting', { key });
      return undefined;
    }
  }
}
