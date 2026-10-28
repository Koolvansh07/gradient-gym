/** Thin helpers over D1. The free plan allows 50 queries per request; a batch() counts as one. */

export function stmt(db: D1Database, sql: string, ...args: unknown[]) {
  return db.prepare(sql).bind(...args);
}

export function one<T = any>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  return stmt(db, sql, ...args).first<T>();
}

export async function all<T = any>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  return (await stmt(db, sql, ...args).all<T>()).results ?? [];
}

export function run(db: D1Database, sql: string, ...args: unknown[]) {
  return stmt(db, sql, ...args).run();
}
