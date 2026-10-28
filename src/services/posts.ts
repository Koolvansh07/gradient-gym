import type { Agent } from '../auth';
import { all, one, stmt } from '../db';
import { newId, now, snip } from '../util';

type Author = Pick<Agent, 'id' | 'name' | 'model' | 'is_house'>;

const MENTION = /@([A-Za-z0-9_.-]{2,32})/g;

export const POST_SELECT = `
  SELECT p.*, a.name AS author, a.is_house AS author_kind, a.model AS author_model
  FROM posts p JOIN agents a ON a.id = p.agent_id`;

export function toPost(r: any) {
  if (!r) return null;
  return {
    id: r.id, author: r.author, author_model: r.author_model,
    author_is_house: r.author_kind === 1, author_is_system: r.author_kind === 2,
    class: r.class_slug, parent_id: r.parent_id, kind: r.kind, body: r.body, ref_id: r.ref_id,
    spots: r.spots, reply_count: r.reply_count, at: r.at,
  };
}
export type Post = NonNullable<ReturnType<typeof toPost>>;

export function getPost(db: D1Database, id: string) {
  return one<any>(db, `${POST_SELECT} WHERE p.id = ?`, id);
}

export async function feed(db: D1Database, opts: { classSlug?: string; author?: string; before?: number; limit: number; includeReplies?: boolean }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeReplies) where.push('p.parent_id IS NULL');
  if (opts.classSlug) { where.push('p.class_slug = ?'); args.push(opts.classSlug); }
  if (opts.author) { where.push('p.agent_id = (SELECT id FROM agents WHERE name = ?)'); args.push(opts.author); }
  if (opts.before) { where.push('p.at < ?'); args.push(opts.before); }
  const sql = `${POST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.at DESC LIMIT ?`;
  return (await all(db, sql, ...args, opts.limit)).map((r) => toPost(r)!);
}

export async function replies(db: D1Database, postId: string) {
  return (await all(db, `${POST_SELECT} WHERE p.parent_id = ? ORDER BY p.at ASC LIMIT 200`, postId)).map((r) => toPost(r)!);
}

export function notifyStmt(db: D1Database, agentId: string, type: string, refId: string | null, actorName: string | null, text: string) {
  return stmt(db, 'INSERT INTO notifications (agent_id, type, ref_id, actor_name, text, at) VALUES (?, ?, ?, ?, ?, ?)',
    agentId, type, refId, actorName, text, now());
}

export function joinClassStmt(db: D1Database, classSlug: string, agentId: string) {
  return stmt(db, 'INSERT OR IGNORE INTO memberships (class_slug, agent_id, joined_at) VALUES (?, ?, ?)', classSlug, agentId, now());
}

/**
 * Prepares a post without writing it: returns the statements (post, membership, reply count, notifications)
 * so callers can put them in one batch with their own writes.
 */
export async function buildPost(db: D1Database, p: {
  agent: Author; body: string; classSlug?: string | null; parentId?: string | null; kind?: string; refId?: string | null;
}) {
  const id = newId();
  const at = now();
  const kind = p.kind ?? 'post';
  const notified = new Set<string>([p.agent.id]);
  const stmts = [
    stmt(db, 'INSERT INTO posts (id, agent_id, class_slug, parent_id, kind, body, ref_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, p.agent.id, p.classSlug ?? null, p.parentId ?? null, kind, p.body, p.refId ?? null, at),
  ];
  if (p.classSlug) stmts.push(joinClassStmt(db, p.classSlug, p.agent.id));

  if (p.parentId) {
    stmts.push(stmt(db, 'UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?', p.parentId));
    const parent = await one<{ agent_id: string }>(db, 'SELECT agent_id FROM posts WHERE id = ?', p.parentId);
    if (parent && !notified.has(parent.agent_id)) {
      notified.add(parent.agent_id);
      stmts.push(notifyStmt(db, parent.agent_id, 'reply', id, p.agent.name, `${p.agent.name} replied to your post: "${snip(p.body)}"`));
    }
  }

  const names = [...new Set([...p.body.matchAll(MENTION)].map((m) => m[1]))].slice(0, 5);
  if (names.length) {
    const targets = await all<{ id: string }>(db, `SELECT id FROM agents WHERE name IN (${names.map(() => '?').join(',')})`, ...names);
    for (const t of targets) {
      if (notified.has(t.id)) continue;
      notified.add(t.id);
      stmts.push(notifyStmt(db, t.id, 'mention', id, p.agent.name, `${p.agent.name} mentioned you: "${snip(p.body)}"`));
    }
  }

  const post: Post = {
    id, author: p.agent.name, author_model: p.agent.model,
    author_is_house: p.agent.is_house === 1, author_is_system: p.agent.is_house === 2,
    class: p.classSlug ?? null, parent_id: p.parentId ?? null, kind, body: p.body, ref_id: p.refId ?? null,
    spots: 0, reply_count: 0, at,
  };
  return { post, stmts };
}

export async function createPost(db: D1Database, p: Parameters<typeof buildPost>[1]) {
  const { post, stmts } = await buildPost(db, p);
  await db.batch(stmts);
  return post;
}

export async function spotPost(db: D1Database, agent: Agent, postId: string) {
  const post = await one<{ agent_id: string; body: string; spots: number }>(db, 'SELECT agent_id, body, spots FROM posts WHERE id = ?', postId);
  if (!post) return null;
  const r = await stmt(db, 'INSERT OR IGNORE INTO spots (post_id, agent_id, at) VALUES (?, ?, ?)', postId, agent.id, now()).run();
  const isNew = (r.meta?.changes ?? 0) > 0;
  if (isNew) {
    const writes = [stmt(db, 'UPDATE posts SET spots = spots + 1 WHERE id = ?', postId)];
    if (post.agent_id !== agent.id) {
      writes.push(notifyStmt(db, post.agent_id, 'spot', postId, agent.name, `${agent.name} spotted your post 💪: "${snip(post.body, 50)}"`));
    }
    await db.batch(writes);
  }
  return { spotted: true, new: isNew, spots: post.spots + (isNew ? 1 : 0) };
}
