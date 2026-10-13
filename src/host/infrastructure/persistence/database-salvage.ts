/**
 * Best-effort salvage of a corrupted database after `openSqliteDatabase` moved
 * it aside and created a fresh, migrated one.
 *
 * - The corrupted copy is opened read-only (never modified) and every table the
 *   fresh schema shares with it is copied row by row, using the columns both
 *   have. Settings (which hold the legacy-import marker) and parent tables go
 *   first, so a budget cut keeps what matters most.
 * - A damaged region is stepped over: each table is scanned forward by rowid
 *   until a read fails, then backward from the end down to that point. Rows
 *   that cannot be read or are rejected by the schema's constraints are skipped.
 * - Foreign keys are off during the copy; orphans are then resolved like the
 *   schema's `ON DELETE` actions (salvage-orphans), so the result satisfies
 *   every constraint.
 * - The run is bounded by a row/time budget (start-up must not hang) and never
 *   throws: every failure is logged and reflected in the report.
 */
import { performance } from 'node:perf_hooks';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { Logger } from '../../application/ports/system.ts';
import { quoteIdentifier as quote, resolveOrphans } from './salvage-orphans.ts';
import { describeError } from './silent-logger.ts';

export interface SalvageBudget {
  readonly maxRows: number;
  readonly maxMillis: number;
}

/**
 * Well inside the 60 s `system.configure` timeout, which also covers the rest of
 * start-up (legacy import, tool probing). Covers both phases: the copy stops at
 * `1 - ORPHAN_PHASE_SHARE` of `maxMillis`, the rest is left to the orphan phase.
 */
export const DEFAULT_SALVAGE_BUDGET: SalvageBudget = { maxRows: 5_000_000, maxMillis: 15_000 };
/**
 * Share of `maxMillis` reserved for resolving orphans after the copy. Measured
 * worst case (every copied row of a table is an orphan): dropping costs about a
 * quarter of copying, so a third leaves a 2x margin.
 */
export const ORPHAN_PHASE_SHARE = 1 / 3;

export interface TableSalvage {
  readonly copied: number;
  /** Rows read but rejected by a constraint, or dropped as orphans. */
  readonly skipped: number;
  /** Part of the table (or its definition) could not be read. */
  readonly unreadable: boolean;
}

export interface SalvageReport {
  /** The corrupted copy could be opened and its table list read. */
  readonly opened: boolean;
  readonly tables: Readonly<Record<string, TableSalvage>>;
  readonly copied: number;
  readonly skipped: number;
  /** Stopped early because the row/time budget ran out. */
  readonly truncated: boolean;
}

export interface SalvageOptions {
  /** The corrupted database file (already moved aside). */
  readonly source: string;
  /** Freshly migrated database, outside any transaction. */
  readonly target: DatabaseSync;
  readonly logger: Logger;
  readonly budget?: SalvageBudget;
  /** Monotonic clock in milliseconds (default `performance.now`). */
  readonly elapsed?: () => number;
}

/** Copied in this order; any other shared table follows alphabetically. */
const TABLE_PRIORITY = ['settings', 'folders', 'batches', 'downloads', 'media_files', 'conversation_events'];
/** Owned by the migration runner of the fresh database. */
const NOT_COPIED = new Set(['schema_migrations']);
const ROWID = '__yami_salvage_rowid';

interface TablePlan {
  readonly name: string;
  readonly columns: readonly string[];
}

interface Counters {
  copied: number;
  skipped: number;
  unreadable: boolean;
}

type Row = Record<string, SQLOutputValue>;

class RowBudget {
  readonly #maxRows: number;
  /** End of the copy phase; the rest of the budget is reserved for the orphan phase. */
  readonly #copyDeadline: number;
  readonly deadline: number;
  readonly elapsed: () => number;
  #rows = 0;
  exhausted = false;

  constructor(budget: SalvageBudget, elapsed: () => number) {
    const start = elapsed();
    this.#maxRows = budget.maxRows;
    this.elapsed = elapsed;
    this.deadline = start + budget.maxMillis;
    this.#copyDeadline = start + budget.maxMillis * (1 - ORPHAN_PHASE_SHARE);
  }

  /** Accounts for one more copied row; `false` (for good) once the copy budget is spent. */
  take(): boolean {
    if (!this.exhausted && (this.#rows >= this.#maxRows || this.elapsed() >= this.#copyDeadline)) {
      this.exhausted = true;
    }
    if (this.exhausted) return false;
    this.#rows += 1;
    return true;
  }
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string' && !NOT_COPIED.has(name));
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${quote(table)})`)
    .all()
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string');
}

function priority(name: string): number {
  const index = TABLE_PRIORITY.indexOf(name);
  return index === -1 ? TABLE_PRIORITY.length : index;
}

function planTables(source: DatabaseSync, target: DatabaseSync): string[] {
  const available = new Set(tableNames(source));
  return tableNames(target)
    .filter((name) => available.has(name))
    .sort((a, b) => priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Copies rows until the scan ends, fails on a damaged page or the budget runs out. */
function copyRows(
  rows: Iterable<Row>,
  insert: StatementSync,
  plan: TablePlan,
  budget: RowBudget,
  counters: Counters
): { readonly lastRowid: number | null; readonly failed: boolean } {
  let lastRowid: number | null = null;
  try {
    for (const row of rows) {
      if (!budget.take()) break;
      const rowid = row[ROWID];
      if (typeof rowid === 'number') lastRowid = rowid;
      try {
        insert.run(...plan.columns.map((column): SQLInputValue => row[column] ?? null));
        counters.copied += 1;
      } catch {
        counters.skipped += 1;
      }
    }
    return { lastRowid, failed: false };
  } catch {
    counters.unreadable = true;
    return { lastRowid, failed: true };
  }
}

function copyTable(
  source: DatabaseSync,
  target: DatabaseSync,
  plan: TablePlan,
  budget: RowBudget,
  counters: Counters
): void {
  const columns = plan.columns.map(quote).join(', ');
  const insert = target.prepare(
    `INSERT INTO ${quote(plan.name)} (${columns}) VALUES (${plan.columns.map(() => '?').join(', ')})`
  );
  const select = `SELECT rowid AS ${ROWID}, ${columns} FROM ${quote(plan.name)}`;
  target.exec('BEGIN');
  try {
    const forward = copyRows(source.prepare(`${select} ORDER BY rowid`).iterate(), insert, plan, budget, counters);
    if (forward.failed && !budget.exhausted) {
      // Rows past the damaged region are still reachable from the other end of the b-tree.
      const after = forward.lastRowid ?? Number.MIN_SAFE_INTEGER;
      const backward = source.prepare(`${select} WHERE rowid > ? ORDER BY rowid DESC`);
      copyRows(backward.iterate(after), insert, plan, budget, counters);
    }
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    counters.skipped += counters.copied;
    counters.copied = 0;
    counters.unreadable = true;
    throw error;
  }
}

function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
}

function report(opened: boolean, counters: ReadonlyMap<string, Counters>, truncated: boolean): SalvageReport {
  const tables: Record<string, TableSalvage> = {};
  let copied = 0;
  let skipped = 0;
  for (const [name, value] of counters) {
    tables[name] = { copied: value.copied, skipped: value.skipped, unreadable: value.unreadable };
    copied += value.copied;
    skipped += value.skipped;
  }
  return { opened, tables, copied, skipped, truncated };
}

function copyAll(
  source: DatabaseSync,
  options: SalvageOptions,
  budget: RowBudget,
  counters: Map<string, Counters>
): void {
  const { target, logger } = options;
  for (const name of planTables(source, target)) {
    const tableCounters: Counters = { copied: 0, skipped: 0, unreadable: false };
    counters.set(name, tableCounters);
    if (budget.exhausted) continue;
    try {
      const available = new Set(columnNames(source, name));
      const columns = columnNames(target, name).filter((column) => available.has(column));
      if (columns.length > 0) copyTable(source, target, { name, columns }, budget, tableCounters);
    } catch (error) {
      tableCounters.unreadable = true;
      logger.warn('database salvage: table not copied', { table: name, error: describeError(error) });
    }
  }
}

export function salvageDatabase(options: SalvageOptions): SalvageReport {
  const { target, logger } = options;
  const budget = new RowBudget(options.budget ?? DEFAULT_SALVAGE_BUDGET, options.elapsed ?? (() => performance.now()));
  const counters = new Map<string, Counters>();
  let source: DatabaseSync | null = null;
  try {
    source = new DatabaseSync(options.source, { readOnly: true });
    // Fails here when not even the table list is readable.
    source.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch (error) {
    closeQuietly(source);
    logger.warn('database salvage: corrupted copy cannot be read', { error: describeError(error) });
    return report(false, counters, false);
  }
  const started = budget.elapsed();
  let copyMillis = 0;
  let orphanMillis = 0;
  try {
    target.exec('PRAGMA foreign_keys = OFF');
    try {
      copyAll(source, options, budget, counters);
      const copied = budget.elapsed();
      copyMillis = copied - started;
      resolveOrphans(target, counters);
      orphanMillis = budget.elapsed() - copied;
      if (budget.elapsed() > budget.deadline) {
        logger.warn('database salvage: orphan phase exceeded the budget', { orphanMillis: Math.round(orphanMillis) });
      }
    } finally {
      // The pragma is a no-op inside a transaction, and the host keeps using this connection.
      if (target.isTransaction) target.exec('ROLLBACK');
      target.exec('PRAGMA foreign_keys = ON');
    }
  } catch (error) {
    logger.warn('database salvage stopped', { error: describeError(error) });
  } finally {
    closeQuietly(source);
  }
  const result = report(true, counters, budget.exhausted);
  logger.info('database salvage finished', {
    copied: result.copied,
    skipped: result.skipped,
    truncated: result.truncated,
    copyMillis: Math.round(copyMillis),
    orphanMillis: Math.round(orphanMillis),
    tables: Object.entries(result.tables)
      .map(([name, t]) => `${name}=${t.copied}/${t.skipped}${t.unreadable ? '!' : ''}`)
      .join(',')
  });
  return result;
}
