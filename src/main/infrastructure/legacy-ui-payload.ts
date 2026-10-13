/**
 * Parses the legacy renderer's `localStorage['yami:v1']` JSON (spec 05 §9). Every field
 * is optional and validated on its own; invalid entries are dropped individually so a
 * single bad folder never loses the rest.
 */
import { LOCALES, type AppSettings, type Locale } from '../../shared/contracts/app-settings.ts';
import { Schemas, type CommandPayload } from '../../shared/contracts/host-protocol.ts';
import { ENGINES, type Engine } from '../../shared/domain/engine.ts';
import { v, type Schema } from '../../shared/validation/schema.ts';

export type LegacyHostData = CommandPayload<'legacy.importUiData'>;

export interface LegacyUiData {
  readonly locale: Locale | null;
  readonly adultBlur: boolean | null;
  /** Legacy `quickEngine`: single-URL composer and tray panel. */
  readonly quickEngine: Engine | null;
  readonly bulkEngine: Engine | null;
  readonly host: LegacyHostData;
}

const localeSchema = v.enum(LOCALES);
const engineSchema = v.enum(ENGINES);
const folderSchema = v.object(
  {
    id: v.id(),
    name: v.string({ min: 1, max: 200, trim: true }),
    color: v.string({ max: 16 }),
    createdAt: v.number({ min: 0 })
  },
  { strict: false }
);
const bindingSchema = v.object(
  {
    id: v.id(),
    siteHost: v.string({ min: 1, max: 253, trim: true }),
    cookieFileName: v.string({ min: 1, max: 128 })
  },
  { strict: false }
);
const idSchema = v.id();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick<T>(schema: Schema<T>, value: unknown): T | null {
  const parsed = schema.parse(value);
  return parsed.ok ? parsed.value : null;
}

function parseFolders(value: unknown): LegacyHostData['folders'] {
  if (!Array.isArray(value)) return [];
  const out: Array<LegacyHostData['folders'][number]> = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 1_000)) {
    const folder = pick(folderSchema, item);
    if (!folder || seen.has(folder.id)) continue;
    seen.add(folder.id);
    const collapsed = isRecord(item) && Boolean(item['collapsed']);
    out.push({
      id: folder.id,
      name: folder.name,
      color: folder.color,
      createdAt: Math.floor(folder.createdAt),
      collapsed
    });
  }
  return out;
}

function parseFolderMap(value: unknown, folderIds: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  let count = 0;
  for (const [conversationId, folderId] of Object.entries(value)) {
    if (count >= 100_000) break;
    if (!pick(idSchema, conversationId) || typeof folderId !== 'string' || !folderIds.has(folderId)) continue;
    out[conversationId] = folderId;
    count += 1;
  }
  return out;
}

function parseBindings(value: unknown): LegacyHostData['cookieBindings'] {
  if (!Array.isArray(value)) return [];
  const out: Array<LegacyHostData['cookieBindings'][number]> = [];
  for (const item of value) {
    if (out.length >= 200) break;
    const binding = pick(bindingSchema, item);
    if (binding) out.push({ id: binding.id, siteHost: binding.siteHost, cookieName: binding.cookieFileName });
  }
  return out;
}

/** Returns `null` for a missing or unparseable payload. */
export function parseLegacyUiPayload(raw: unknown): LegacyUiData | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const folders = parseFolders(data['conversationFolders']);
  const host: LegacyHostData = {
    folders,
    folderMap: parseFolderMap(data['conversationFolderMap'], new Set(folders.map((folder) => folder.id))),
    cookieBindings: parseBindings(data['cookieBindings'])
  };
  // Final guard: the host re-validates, but never send what the contract rejects.
  const checked = Schemas.importLegacyUiData.parse(host);

  return {
    locale: pick(localeSchema, data['locale']),
    adultBlur: typeof data['blurAdultContent'] === 'boolean' ? data['blurAdultContent'] : null,
    quickEngine: pick(engineSchema, data['quickEngine']),
    bulkEngine: pick(engineSchema, data['bulkEngine']),
    host: checked.ok ? checked.value : { folders: [], folderMap: {}, cookieBindings: [] }
  };
}

export function hasHostData(data: LegacyHostData): boolean {
  return data.folders.length > 0 || data.cookieBindings.length > 0 || Object.keys(data.folderMap).length > 0;
}

/** Applies the legacy renderer preferences on top of the current settings. */
export function applyLegacyPreferences(settings: AppSettings, legacy: LegacyUiData, importedAt: number): AppSettings {
  const single = legacy.quickEngine ?? settings.ui.composerEngine.single;
  const bulk = legacy.bulkEngine ?? settings.ui.composerEngine.bulk;
  return {
    ...settings,
    locale: legacy.locale ?? settings.locale,
    adultBlur: legacy.adultBlur ?? settings.adultBlur,
    ui: {
      ...settings.ui,
      composerEngine: { single, bulk },
      trayEngine: legacy.quickEngine ?? settings.ui.trayEngine
    },
    legacyImportedAt: importedAt
  };
}
