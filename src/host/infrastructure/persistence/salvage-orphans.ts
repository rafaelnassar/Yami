/**
 * Second phase of the database salvage: rows copied with foreign keys off may
 * reference parents that could not be salvaged. Each foreign key of the fresh
 * schema gets one set-based statement that applies the `ON DELETE` action the
 * missing parent would have triggered: `SET NULL` clears the reference and keeps
 * the row; any other action (or a `SET NULL` the column rejects) drops it.
 *
 * Tables are handled parents first, so a dropped row's children are cleaned in
 * the same pass (cascades). Every statement is a scan of one child table with a
 * primary-key probe per row — cheaper than the row-by-row copy that filled it
 * (dropping every row of a table costs about a quarter of copying it), which is
 * what keeps this phase inside the time the salvage reserves for it.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Per-table counters of the salvage, adjusted for dropped rows. */
export interface OrphanCounters {
  copied: number;
  skipped: number;
}

/** Only reached with foreign-key cycles, which the schema does not have. */
const MAX_ROUNDS = 4;
const PARENT_ALIAS = '__yami_parent';

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

interface ForeignKey {
  readonly table: string;
  readonly parent: string;
  readonly from: readonly string[];
  /** Referenced columns (empty: the parent's primary key). */
  readonly to: readonly string[];
  readonly setNull: boolean;
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string');
}

function foreignKeysOf(db: DatabaseSync, table: string): ForeignKey[] {
  const groups = new Map<number, Record<string, unknown>[]>();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()) {
    const id = typeof row['id'] === 'number' ? row['id'] : -1;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  const keys: ForeignKey[] = [];
  for (const rows of groups.values()) {
    const ordered = [...rows].sort((a, b) => Number(a['seq']) - Number(b['seq']));
    const parent = ordered[0]?.['table'];
    const from = ordered.map((row) => row['from']).filter((name): name is string => typeof name === 'string');
    const to = ordered.map((row) => row['to']).filter((name): name is string => typeof name === 'string');
    if (typeof parent !== 'string' || from.length === 0) continue;
    keys.push({
      table,
      parent,
      from,
      to: to.length === from.length ? to : [],
      setNull: ordered[0]?.['on_delete'] === 'SET NULL'
    });
  }
  return keys;
}

function primaryKey(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .filter((row) => typeof row['pk'] === 'number' && row['pk'] > 0)
    .sort((a, b) => Number(a['pk']) - Number(b['pk']))
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string');
}

/** `WHERE` clause matching the child rows whose (non-null) reference has no parent row. */
function orphanCondition(fk: ForeignKey, parentColumns: readonly string[] | null): string {
  const child = quoteIdentifier(fk.table);
  const notNull = fk.from.map((column) => `${child}.${quoteIdentifier(column)} IS NOT NULL`).join(' AND ');
  if (parentColumns === null || parentColumns.length !== fk.from.length) return notNull;
  const match = fk.from
    .map(
      (column, i) => `${PARENT_ALIAS}.${quoteIdentifier(parentColumns[i] ?? '')} = ${child}.${quoteIdentifier(column)}`
    )
    .join(' AND ');
  return `${notNull} AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(fk.parent)} AS ${PARENT_ALIAS} WHERE ${match})`;
}

/** Applies the `ON DELETE` action of one key; returns the number of rows dropped. */
function resolveKey(db: DatabaseSync, fk: ForeignKey, tables: ReadonlySet<string>): number {
  const parentColumns = tables.has(fk.parent) ? (fk.to.length > 0 ? fk.to : primaryKey(db, fk.parent)) : null;
  const where = orphanCondition(fk, parentColumns);
  const child = quoteIdentifier(fk.table);
  if (fk.setNull) {
    const assignments = fk.from.map((column) => `${quoteIdentifier(column)} = NULL`).join(', ');
    try {
      db.prepare(`UPDATE ${child} SET ${assignments} WHERE ${where}`).run();
      return 0;
    } catch {
      /* e.g. a NOT NULL column: drop the rows instead */
    }
  }
  return Number(db.prepare(`DELETE FROM ${child} WHERE ${where}`).run().changes);
}

/** Tables with foreign keys, parents before children (cycles appended in name order). */
function dependencyOrder(keys: ReadonlyMap<string, readonly ForeignKey[]>): string[] {
  const ordered: string[] = [];
  const remaining = new Set(keys.keys());
  for (let progress = true; progress && remaining.size > 0;) {
    progress = false;
    for (const table of [...remaining]) {
      const blocked = (keys.get(table) ?? []).some((fk) => fk.parent !== table && remaining.has(fk.parent));
      if (blocked) continue;
      ordered.push(table);
      remaining.delete(table);
      progress = true;
    }
  }
  return [...ordered, ...remaining];
}

/** Must run outside a transaction, with foreign keys off; throws only when the target cannot be written. */
export function resolveOrphans(target: DatabaseSync, counters: ReadonlyMap<string, OrphanCounters>): void {
  const tables = new Set(tableNames(target));
  const keys = new Map<string, ForeignKey[]>();
  for (const table of tables) {
    const found = foreignKeysOf(target, table);
    if (found.length > 0) keys.set(table, found);
  }
  const order = dependencyOrder(keys);
  const position = new Map(order.map((table, index) => [table, index] as const));
  let pending = order;
  target.exec('BEGIN');
  try {
    for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round += 1) {
      const droppedFrom = new Set<string>();
      for (const table of pending) {
        for (const fk of keys.get(table) ?? []) {
          const dropped = resolveKey(target, fk, tables);
          if (dropped === 0) continue;
          droppedFrom.add(table);
          const tableCounters = counters.get(table);
          if (tableCounters) {
            tableCounters.copied -= dropped;
            tableCounters.skipped += dropped;
          }
        }
      }
      // Children handled before the table they reference lost rows (only possible in a cycle).
      pending = order.filter((table) =>
        (keys.get(table) ?? []).some(
          (fk) => droppedFrom.has(fk.parent) && (position.get(table) ?? 0) <= (position.get(fk.parent) ?? 0)
        )
      );
    }
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  }
}
