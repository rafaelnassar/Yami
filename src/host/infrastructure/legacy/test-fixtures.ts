/** Test-only builders for a fabricated legacy `~/.yami` directory (schema v1, spec 02 §4.2). */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LEGACY_V1_DDL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS download_batches (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL CHECK (engine IN ('gallery-dl', 'yt-dlp')),
  scope TEXT NOT NULL CHECK (scope IN ('single', 'bulk')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS download_conversations (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES download_batches(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('gallery-dl', 'yt-dlp')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  files_downloaded INTEGER NOT NULL DEFAULT 0 CHECK (files_downloaded >= 0),
  files_skipped INTEGER NOT NULL DEFAULT 0 CHECK (files_skipped >= 0),
  errors_count INTEGER NOT NULL DEFAULT 0 CHECK (errors_count >= 0),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS download_files (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES download_conversations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio', 'document', 'other')),
  extension TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, path)
) STRICT;
CREATE TABLE IF NOT EXISTS download_events (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES download_conversations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON download_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_batch ON download_conversations(batch_id);
CREATE INDEX IF NOT EXISTS idx_files_conversation_created ON download_files(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_events_conversation_created ON download_events(conversation_id, created_at, id);
INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, 1);
`;

export const LEGACY_COOKIES = '# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t1893456000\tauth_token\tsecret\n';

/**
 * Builds a legacy dir with:
 * - batch `b-old` (completed): `c-done` (completed, 2 files incl. one sidecar, 3 events),
 *   `c-fail` (failed, no files);
 * - batch `b-live` (running): `c-run` (running in DB, fresher in state.json), `c-pend` (only in state.json);
 * - `bad id!` (invalid id, skipped);
 * - cookies `x.com.txt` (valid), `reddit.cookies` (valid, renamed), `broken.txt` (invalid), `.hidden`;
 * - credentials with a Pixiv token; state.json config.
 */
export function buildLegacyDir(root: string): string {
  const dir = path.join(root, '.yami');
  mkdirSync(path.join(dir, 'cookies'), { recursive: true });
  const staging = path.join(root, 'staging');
  mkdirSync(staging, { recursive: true });
  const db = new DatabaseSync(path.join(staging, 'yami.sqlite'));
  db.exec(LEGACY_V1_DDL);
  const batch = db.prepare(
    'INSERT INTO download_batches (id, engine, scope, status, total_items, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  batch.run('b-old', 'gallery-dl', 'bulk', 'completed', 2, 1_000, 1_900);
  batch.run('b-live', 'yt-dlp', 'bulk', 'running', 2, 5_000, null);
  const conversation = db.prepare(
    `INSERT INTO download_conversations (id, batch_id, source_url, title, engine, status, summary, files_downloaded,
      files_skipped, errors_count, created_at, started_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  conversation.run(
    'c-done',
    'b-old',
    'https://x.com/artist/media',
    'artist',
    'gallery-dl',
    'completed',
    '2 baixado(s), 1 ignorado(s)',
    2,
    1,
    0,
    1_000,
    1_100,
    1_800,
    1_850
  );
  conversation.run(
    'c-fail',
    'b-old',
    'https://example.com/post/9',
    '9',
    'gallery-dl',
    'failed',
    'ERROR: 404',
    0,
    0,
    1,
    1_001,
    1_101,
    1_900,
    1_950
  );
  conversation.run(
    'c-run',
    'b-live',
    'https://www.youtube.com/watch?v=abc',
    'abc',
    'yt-dlp',
    'running',
    '',
    1,
    0,
    0,
    5_000,
    5_100,
    null,
    5_200
  );
  conversation.run(
    'bad id!',
    null,
    'https://example.com/x',
    'x',
    'gallery-dl',
    'completed',
    '',
    0,
    0,
    0,
    10,
    null,
    20,
    20
  );
  const file = db.prepare(
    `INSERT INTO download_files (conversation_id, path, name, media_type, extension, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  file.run('c-done', '/dl/gallery-dl/x/1 🎉.jpg', '1 🎉.jpg', 'image', '.jpg', 111, 1_200);
  file.run('c-done', '/dl/gallery-dl/x/2.svg', '2.svg', 'image', '.svg', null, 1_300);
  file.run('c-done', '/dl/gallery-dl/x/2.info.json', '2.info.json', 'document', '.json', 5, 1_301);
  const event = db.prepare(
    'INSERT INTO download_events (conversation_id, event_type, level, message, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  event.run('c-done', 'created', 'info', 'Download adicionado à conversa.', 1_000);
  event.run('c-done', 'started', 'info', 'Download iniciado com gallery-dl.', 1_100);
  event.run('c-done', 'completed', 'success', '2 baixado(s), 1 ignorado(s)', 1_800);
  event.run('c-run', 'started', 'info', 'Download iniciado com yt-dlp.', 5_100);
  // Snapshot while the connection is open: most rows live only in the WAL, as after a legacy host crash.
  copyFileSync(path.join(staging, 'yami.sqlite'), path.join(dir, 'yami.sqlite'));
  copyFileSync(path.join(staging, 'yami.sqlite-wal'), path.join(dir, 'yami.sqlite-wal'));
  db.close();

  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify(
      {
        jobs: [
          {
            id: 'c-run',
            batchId: 'b-live',
            url: 'https://www.youtube.com/watch?v=abc',
            engine: 'yt-dlp',
            scope: 'bulk',
            cookiesPath: '/home/u/.yami/cookies/x.com.txt',
            pid: 4321,
            status: 'running',
            logFile: '/x.log',
            logOffset: 10,
            createdAt: 5_000,
            startedAt: 5_100,
            completedAt: null,
            summary: '',
            stats: { done: 3, skipped: 1, errors: 0 },
            _tailer: {}
          },
          {
            id: 'c-pend',
            batchId: 'b-live',
            url: 'https://www.youtube.com/watch?v=def',
            engine: 'yt-dlp',
            scope: 'bulk',
            cookiesPath: null,
            pid: null,
            status: 'pending',
            createdAt: 5_001,
            startedAt: null,
            completedAt: null,
            stats: { done: 0, skipped: 0, errors: 0 }
          },
          {
            id: 'c-done',
            url: 'https://x.com/artist/media',
            engine: 'gallery-dl',
            status: 'completed',
            createdAt: 1_000
          },
          { id: 'broken', url: 'javascript:alert(1)', engine: 'gallery-dl', status: 'pending' }
        ],
        batches: {
          'b-live': {
            id: 'b-live',
            total: 2,
            engine: 'yt-dlp',
            scope: 'bulk',
            createdAt: 5_000,
            finalNotifiedAt: null
          },
          'b-state': {
            id: 'b-state',
            total: 1,
            engine: 'gallery-dl',
            scope: 'weird',
            createdAt: 4_000,
            finalNotifiedAt: 4_500
          }
        },
        currentBatchId: 'b-live',
        concurrentLimit: 4,
        maxSlotWeight: 8,
        config: {
          engine: 'yt-dlp',
          downloadDir: '/home/u/Downloads/Yami',
          cookiesPath: '/home/u/.yami/cookies/x.com.txt',
          cookiesFromBrowser: true,
          runtimeMode: 'python',
          setupDismissed: true,
          paths: { 'gallery-dl': null, 'yt-dlp': null }
        }
      },
      null,
      2
    )
  );
  writeFileSync(path.join(dir, 'cookies', 'x.com.txt'), LEGACY_COOKIES);
  writeFileSync(path.join(dir, 'cookies', 'reddit.cookies'), LEGACY_COOKIES.replace('.x.com', '.reddit.com'));
  writeFileSync(path.join(dir, 'cookies', 'broken.txt'), 'not cookies');
  writeFileSync(path.join(dir, 'cookies', '.hidden'), LEGACY_COOKIES);
  writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify({ pixiv: { refreshToken: '  pixiv-token-123  ', userName: 'Artist', userId: 77, updatedAt: 3_000 } })
  );
  return dir;
}
