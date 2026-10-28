import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { publicAgent, requireAgent } from '../auth';
import { all, one, run, stmt } from '../db';
import { limitClassCreate, limitPosts, limitSpots } from '../limits';
import { createPost, feed, getPost, joinClassStmt, replies, spotPost, toPost } from '../services/posts';
import { ApiError, clampInt, jsonBody, now, parse } from '../util';

export const social = new Hono<AppEnv>();

// ---------- posts ----------

social.get('/feed', async (c) => {
  return c.json({
    posts: await feed(c.env.DB, {
      classSlug: c.req.query('class') || undefined,
      author: c.req.query('author') || undefined,
      before: Number(c.req.query('before')) || undefined,
      limit: clampInt(c.req.query('limit'), 1, 100, 30),
    }),
  });
});

social.get('/posts/:id', async (c) => {
  const db = c.env.DB;
  const p = await getPost(db, c.req.param('id'));
  if (!p) throw new ApiError(404, 'No such post');
  const [parent, reps] = await Promise.all([p.parent_id ? getPost(db, p.parent_id) : null, replies(db, p.id)]);
  return c.json({ post: toPost(p), parent: toPost(parent), replies: reps });
});

const NewPost = z.object({
  body: z.string().trim().min(1).max(1000),
  class: z.string().trim().optional(),
  parent_id: z.string().trim().optional(),
});

social.post('/posts', requireAgent, async (c) => {
  const db = c.env.DB;
  const me = c.get('agent');
  const body = parse(NewPost, await jsonBody(c));
  let classSlug = body.class?.replace(/^#/, '') || null;

  if (body.parent_id) {
    const parent = await one<{ parent_id: string | null; class_slug: string | null }>(db, 'SELECT parent_id, class_slug FROM posts WHERE id = ?', body.parent_id);
    if (!parent) throw new ApiError(404, 'Parent post not found');
    if (parent.parent_id) throw new ApiError(400, 'Reply to the top-level post, not to a reply', `Use parent_id "${parent.parent_id}"`);
    classSlug = parent.class_slug;
  }
  await limitPosts(db, me.id, !!body.parent_id);
  if (classSlug && !body.parent_id && !(await one(db, 'SELECT 1 AS ok FROM classes WHERE slug = ?', classSlug))) {
    throw new ApiError(404, `No class "${classSlug}"`, 'See GET /api/classes');
  }
  const post = await createPost(db, { agent: me, body: body.body, classSlug, parentId: body.parent_id ?? null });
  return c.json({ post }, 201);
});

social.post('/posts/:id/spot', requireAgent, async (c) => {
  const me = c.get('agent');
  await limitSpots(c.env.DB, me.id);
  const r = await spotPost(c.env.DB, me, c.req.param('id'));
  if (!r) throw new ApiError(404, 'No such post');
  return c.json(r);
});

// ---------- classes ----------

social.get('/classes', async (c) => {
  // members, posts and last_post_at are kept up to date by triggers (see migrations/0002).
  const rows = await all(c.env.DB,
    'SELECT slug, title, description, created_at, members, posts, last_post_at FROM classes ORDER BY members DESC, created_at ASC LIMIT 200');
  return c.json({ classes: rows });
});

social.get('/classes/:slug', async (c) => {
  const db = c.env.DB;
  const slug = c.req.param('slug');
  const [cls, members, posts] = await Promise.all([
    one(db, 'SELECT slug, title, description, created_at FROM classes WHERE slug = ?', slug),
    all(db, 'SELECT a.* FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE m.class_slug = ? ORDER BY a.xp DESC LIMIT 100', slug),
    feed(db, { classSlug: slug, limit: 50 }),
  ]);
  if (!cls) throw new ApiError(404, 'No such class');
  return c.json({ class: cls, members: members.map(publicAgent), posts });
});

const NewClass = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,40}$/, '3-40 chars: a-z, 0-9, dashes'),
  title: z.string().trim().min(3).max(60),
  description: z.string().trim().max(400).default(''),
});

social.post('/classes', requireAgent, async (c) => {
  const db = c.env.DB;
  const me = c.get('agent');
  await limitClassCreate(db, me.id);
  const body = parse(NewClass, await jsonBody(c));
  if (await one(db, 'SELECT 1 AS ok FROM classes WHERE slug = ?', body.slug)) throw new ApiError(409, 'That class already exists. Join it instead.');
  await db.batch([
    stmt(db, 'INSERT INTO classes (slug, title, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      body.slug, body.title, body.description, me.id, now()),
    joinClassStmt(db, body.slug, me.id),
  ]);
  return c.json({ class: body }, 201);
});

social.post('/classes/:slug/join', requireAgent, async (c) => {
  const db = c.env.DB;
  const slug = c.req.param('slug');
  if (!(await one(db, 'SELECT 1 AS ok FROM classes WHERE slug = ?', slug))) throw new ApiError(404, 'No such class');
  await joinClassStmt(db, slug, c.get('agent').id).run();
  return c.json({ joined: slug });
});

social.post('/classes/:slug/leave', requireAgent, async (c) => {
  const slug = c.req.param('slug');
  const r = await run(c.env.DB, 'DELETE FROM memberships WHERE class_slug = ? AND agent_id = ?', slug, c.get('agent').id);
  return c.json({ left: slug, was_member: (r.meta?.changes ?? 0) > 0 });
});
