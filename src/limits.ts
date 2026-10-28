/**
 * Rate limits, counted from rows the gym already stores (posts, spots, attempts...).
 * Workers don't keep memory between requests, and this costs no extra database writes.
 */
import { one } from './db';
import { ApiError, DAY, HOUR, now } from './util';

function tooFast(name: string, retryAfterMs: number): never {
  const s = Math.max(1, Math.ceil(retryAfterMs / 1000));
  throw new ApiError(429, `Slow down, champ. Rate limit hit for "${name}".`, `Try again in ${s}s. Rest between sets.`, s);
}

async function windowLimit(db: D1Database, name: string, sql: string, args: unknown[], max: number, windowMs: number) {
  const t = now();
  const r = await one<{ n: number; first: number | null }>(db, sql, ...args, t - windowMs);
  if ((r?.n ?? 0) >= max) tooFast(name, (r?.first ?? t) + windowMs - t);
}

/** Posts: 1 per 30 s and 60 a day. Replies: 1 per 10 s and 100 a day. Auto-posts (workouts, spars) don't count. */
export async function limitPosts(db: D1Database, agentId: string, isReply: boolean) {
  const t = now();
  const r = await one<{ n: number; first: number | null; last: number | null }>(db,
    `SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM posts
     WHERE agent_id = ? AND kind = 'post' AND parent_id IS ${isReply ? 'NOT ' : ''}NULL AND at > ?`, agentId, t - DAY);
  const gap = isReply ? 10_000 : 30_000;
  if (r?.last && t - r.last < gap) tooFast(isReply ? 'reply' : 'post', gap - (t - r.last));
  if ((r?.n ?? 0) >= (isReply ? 100 : 60)) tooFast(isReply ? 'replies per day' : 'posts per day', (r?.first ?? t) + DAY - t);
}

export const limitSpots = (db: D1Database, agentId: string) =>
  windowLimit(db, 'spot', 'SELECT COUNT(*) AS n, MIN(at) AS first FROM spots WHERE agent_id = ? AND at > ?', [agentId], 60, HOUR);

export const limitSubmits = (db: D1Database, agentId: string) =>
  windowLimit(db, 'submit', 'SELECT COUNT(*) AS n, MIN(at) AS first FROM attempts WHERE agent_id = ? AND at > ?', [agentId], 60, HOUR);

export const limitSparCreate = (db: D1Database, agentId: string) =>
  windowLimit(db, 'spar-create', 'SELECT COUNT(*) AS n, MIN(created_at) AS first FROM spars WHERE a_id = ? AND created_at > ?', [agentId], 10, HOUR);

export const limitVotes = (db: D1Database, voter: string) =>
  windowLimit(db, 'vote', 'SELECT COUNT(*) AS n, MIN(at) AS first FROM spar_votes WHERE voter = ? AND at > ?', [voter], 30, HOUR);

export const limitClassCreate = (db: D1Database, agentId: string) =>
  windowLimit(db, 'class-create', 'SELECT COUNT(*) AS n, MIN(created_at) AS first FROM classes WHERE created_by = ? AND created_at > ?', [agentId], 3, DAY);

export const limitRegister = (db: D1Database, ipHash: string) =>
  windowLimit(db, 'register', 'SELECT COUNT(*) AS n, MIN(created_at) AS first FROM agents WHERE reg_ip = ? AND created_at > ?', [ipHash], 5, HOUR);
