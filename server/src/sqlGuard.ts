import { readonlyDb } from './db.js';

/**
 * Safety layer for AI-generated SQL. Defence in depth:
 *  1. Text checks: single statement, must start with SELECT/WITH, no write/admin keywords.
 *  2. SQLite confirms the prepared statement is read-only (stmt.reader).
 *  3. It runs on a connection opened with { readonly: true }.
 *  4. Results are capped with an outer LIMIT.
 */

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;

export const MAX_ROWS = 500;

export class UnsafeSqlError extends Error {}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Removes string literals so keyword checks don't trip on values like 'Update room'. */
function withoutStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

export function validateSql(input: string): string {
  let sql = stripComments(input).trim().replace(/;\s*$/, '').trim();
  if (!sql) throw new UnsafeSqlError('Empty query.');
  const bare = withoutStrings(sql);
  if (bare.includes(';')) throw new UnsafeSqlError('Only one SQL statement is allowed.');
  if (!/^(select|with)\b/i.test(bare)) throw new UnsafeSqlError('Only SELECT queries are allowed.');
  const bad = bare.match(FORBIDDEN);
  if (bad) throw new UnsafeSqlError(`Keyword "${bad[1].toUpperCase()}" is not allowed.`);
  return sql;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  ms: number;
}

export function runReadOnly(rawSql: string): QueryResult {
  const sql = validateSql(rawSql);
  const db = readonlyDb();
  const capped = `SELECT * FROM (${sql}) LIMIT ${MAX_ROWS + 1}`;
  const stmt = db.prepare(capped);
  if (!stmt.reader) throw new UnsafeSqlError('Query does not return rows.');
  const t0 = performance.now();
  const rows = stmt.all() as Record<string, unknown>[];
  const ms = Math.round(performance.now() - t0);
  const columns = stmt.columns().map((c) => c.name);
  const truncated = rows.length > MAX_ROWS;
  return { columns, rows: truncated ? rows.slice(0, MAX_ROWS) : rows, truncated, ms };
}
