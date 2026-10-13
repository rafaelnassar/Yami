/**
 * Schema version 1 of `yami.db` (full schema of the rewrite).
 *
 * Notes:
 * - Every table is STRICT; JSON columns are checked with `json_valid` and
 *   validated again (with `v.*` schemas) when read.
 * - Foreign keys are DEFERRABLE INITIALLY DEFERRED so a unit of work may save a
 *   download before its batch inside one transaction; ON DELETE actions still run
 *   immediately.
 * - `media_files.conversation_id` is nullable (files known to the library but not
 *   produced by a conversation); a partial unique index keeps those paths unique.
 */
export const SCHEMA_V1 = `
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL CHECK (engine IN ('gallery-dl', 'yt-dlp')),
  scope TEXT NOT NULL CHECK (scope IN ('single', 'bulk')),
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL,
  notified_at INTEGER
) STRICT;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_folders_position ON folders(position, created_at);

CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('gallery-dl', 'yt-dlp')),
  scope TEXT NOT NULL CHECK (scope IN ('single', 'bulk')),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  outcome TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
  legacy_summary TEXT,
  counters TEXT NOT NULL CHECK (json_valid(counters)),
  cookie_name TEXT,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  process TEXT CHECK (process IS NULL OR json_valid(process)),
  log_file TEXT,
  log_offset INTEGER NOT NULL DEFAULT 0 CHECK (log_offset >= 0),
  retry TEXT NOT NULL CHECK (json_valid(retry)),
  used_browser_cookies INTEGER NOT NULL DEFAULT 0 CHECK (used_browser_cookies IN (0, 1)),
  last_error_kind TEXT,
  error_lines TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(error_lines))
) STRICT;

CREATE INDEX idx_downloads_status ON downloads(status, position);
CREATE INDEX idx_downloads_position ON downloads(position);
CREATE INDEX idx_downloads_updated ON downloads(updated_at DESC, id DESC);
CREATE INDEX idx_downloads_batch ON downloads(batch_id);
CREATE INDEX idx_downloads_folder ON downloads(folder_id);

CREATE TABLE media_files (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES downloads(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio', 'document', 'other')),
  extension TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, path)
) STRICT;

CREATE UNIQUE INDEX idx_media_files_orphan_path ON media_files(path) WHERE conversation_id IS NULL;
CREATE INDEX idx_media_files_conversation_created ON media_files(conversation_id, created_at, id);
-- Covers the per-conversation aggregates (primary media type, total bytes) of the history list.
CREATE INDEX idx_media_files_conversation_type ON media_files(conversation_id, media_type, size_bytes);
-- NOCASE so Windows lookups can use it; exact (binary) matching is re-checked in code.
CREATE INDEX idx_media_files_path ON media_files(path COLLATE NOCASE);

CREATE TABLE conversation_events (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  type TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
  code TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
  legacy_message TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_events_conversation_created ON conversation_events(conversation_id, created_at, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;
`;
