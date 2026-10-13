/**
 * Schemas used to validate rows (and their JSON columns) read from SQLite.
 * Stored data is untrusted: a row that fails validation is skipped and logged,
 * never allowed to crash the host.
 */
import { v, type Schema } from '../../../shared/validation/schema.ts';
import { ok, err, type Result } from '../../../shared/kernel/result.ts';
import { DOWNLOAD_SCOPES, ENGINES } from '../../../shared/domain/engine.ts';
import { MEDIA_TYPES } from '../../../shared/domain/media.ts';
import { CONVERSATION_EVENT_TYPES, DOWNLOAD_STATUSES } from '../../../shared/contracts/dto.ts';
import { ENGINE_ERROR_KINDS } from '../../domain/engines/parsed-line.ts';

/** Free text read back from the database (engine output may contain control chars). */
export const text = v.string({ max: 1_000_000, noControlChars: false });
export const nonEmptyText = v.string({ min: 1, max: 1_000_000, noControlChars: false });
const int = v.number({ int: true });
const nonNegativeInt = v.number({ int: true, min: 0 });

export const OUTCOME_KINDS = ['ok', 'partial', 'empty', 'error', 'cancelled'] as const;
export const EVENT_LEVELS = ['info', 'success', 'warning', 'error'] as const;

export const OutcomeSchema = v.object(
  { kind: v.enum(OUTCOME_KINDS), reason: v.nullable(text), detail: v.nullable(text) },
  { strict: false }
);

export const CountersSchema = v.object(
  { done: nonNegativeInt, skipped: nonNegativeInt, errors: nonNegativeInt },
  { strict: false }
);

export const ProcessIdentitySchema = v.object(
  {
    pid: nonNegativeInt,
    imageName: v.nullable(text),
    startToken: v.nullable(text),
    startTokenSource: v.nullable(v.enum(['wmic', 'powershell', 'proc', 'ps'] as const)),
    executable: v.nullable(text),
    capturedAt: v.number()
  },
  { strict: false }
);

export const RetrySchema = v.object(
  {
    browserCookieMode: v.nullable(v.enum(['skip', 'force'] as const)),
    skipTried: v.boolean(),
    forceTried: v.boolean()
  },
  { strict: false }
);

export const ErrorLinesSchema = v.array(text, { max: 100 });

export const ParamsSchema = v.record(v.union(text, v.number(), v.boolean(), v.literal(null)), {
  maxKeys: 200,
  key: v.string({ min: 1, max: 256 })
});

export const DownloadRowSchema = v.object(
  {
    id: nonEmptyText,
    batch_id: v.nullable(text),
    source_url: text,
    title: text,
    engine: v.enum(ENGINES),
    scope: v.enum(DOWNLOAD_SCOPES),
    status: v.enum(DOWNLOAD_STATUSES),
    outcome: v.nullable(text),
    legacy_summary: v.nullable(text),
    counters: text,
    cookie_name: v.nullable(text),
    folder_id: v.nullable(text),
    position: int,
    created_at: int,
    started_at: v.nullable(int),
    completed_at: v.nullable(int),
    updated_at: int,
    process: v.nullable(text),
    log_file: v.nullable(text),
    log_offset: nonNegativeInt,
    retry: text,
    used_browser_cookies: v.number({ int: true, min: 0, max: 1 }),
    last_error_kind: v.nullable(v.enum(ENGINE_ERROR_KINDS)),
    error_lines: text
  },
  { strict: false }
);

export const BatchRowSchema = v.object(
  {
    id: nonEmptyText,
    engine: v.enum(ENGINES),
    scope: v.enum(DOWNLOAD_SCOPES),
    total: nonNegativeInt,
    created_at: int,
    notified_at: v.nullable(int)
  },
  { strict: false }
);

export const MediaFileRowSchema = v.object(
  {
    id: nonNegativeInt,
    conversation_id: v.nullable(text),
    path: nonEmptyText,
    name: text,
    media_type: v.enum(MEDIA_TYPES),
    extension: text,
    size_bytes: v.nullable(nonNegativeInt),
    created_at: int
  },
  { strict: false }
);

export const EventRowSchema = v.object(
  {
    id: nonNegativeInt,
    conversation_id: nonEmptyText,
    type: v.enum(CONVERSATION_EVENT_TYPES),
    level: v.enum(EVENT_LEVELS),
    code: text,
    params: text,
    legacy_message: v.nullable(text),
    created_at: int
  },
  { strict: false }
);

export const FolderRowSchema = v.object(
  {
    id: nonEmptyText,
    name: text,
    color: text,
    collapsed: v.number({ int: true, min: 0, max: 1 }),
    position: int,
    created_at: int
  },
  { strict: false }
);

/** Parses a JSON column and validates it; returns a short reason on failure. */
export function parseJsonColumn<T>(raw: string, schema: Schema<T>): Result<T, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return err('invalid json');
  }
  const parsed = schema.parse(value);
  return parsed.ok ? ok(parsed.value) : err(`${parsed.error.path}: ${parsed.error.reason}`);
}
