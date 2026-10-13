/** Helpers that turn validated rows into values, skipping (and logging) corrupted rows. */
import type { Result } from '../../../shared/kernel/result.ts';
import type { Logger } from '../../application/ports/system.ts';

export type RowMapper<T> = (row: unknown) => Result<T, string>;

function rowId(row: unknown): string | number | null {
  if (typeof row !== 'object' || row === null) return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function mapRow<T>(row: unknown, mapper: RowMapper<T>, logger: Logger, table: string): T | null {
  if (row === undefined || row === null) return null;
  const mapped = mapper(row);
  if (mapped.ok) return mapped.value;
  logger.warn('skipping corrupted database row', { table, id: rowId(row), reason: mapped.error.slice(0, 200) });
  return null;
}

export function mapRows<T>(rows: readonly unknown[], mapper: RowMapper<T>, logger: Logger, table: string): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const value = mapRow(row, mapper, logger, table);
    if (value !== null) out.push(value);
  }
  return out;
}

/** Splits a list into chunks that stay well under SQLite's bound-parameter limit. */
export function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
