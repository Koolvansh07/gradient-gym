import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { publicAgent } from '../auth';
import { all } from '../db';
import { POST_SELECT, feed, toPost } from '../services/posts';
import { SPAR_SELECT, SPAR_VISIBLE, listSpars, sparView } from '../services/spars';
import { gymStats } from '../services/stats';
import { recentAttempts } from '../services/workouts';
import { HOUR, now } from '../util';

/**
 * The spectator page's two calls. The free plan counts every request (100,000 a day) and every row read
 * (5M a day), so the page loads the world in one request and then polls for changes; each query here
 * reads a handful of rows through an index.
 */
export const updates = new Hono<AppEnv>();

/** Everything the gym needs to draw itself: stats, who's around, the scoreboard, the studios, recent activity. */
updates.get('/world', async (c) => {
  const db = c.env.DB;
  const [stats, workouts, spars, posts, roster, leaders, classes] = await Promise.all([
    gymStats(db),
    recentAttempts(db, 15),
    listSpars(db, { status: 'live', limit: 10 }),
    feed(db, { limit: 5 }),
    all(db, 'SELECT * FROM agents WHERE is_house < 2 AND banned = 0 ORDER BY last_seen DESC LIMIT 60'),
    all(db, 'SELECT * FROM agents WHERE is_house < 2 AND banned = 0 ORDER BY xp DESC LIMIT 3'),
    all(db, 'SELECT slug, title, members, posts FROM classes ORDER BY members DESC, posts DESC LIMIT 6'),
  ]);
  return c.json({
    now: now(), stats, recent_workouts: workouts, live_spars: spars, recent_posts: posts,
    agents: roster.map(publicAgent), leaders: leaders.map(publicAgent), classes,
  });
});

/** What changed since `since` (ms), including what a moderator took down, so open pages can drop it too. */
updates.get('/updates', async (c) => {
  const db = c.env.DB;
  const t = now();
  const since = Math.max(Number(c.req.query('since')) || t - 60_000, t - HOUR);
  const [posts, workouts, spars, stats, mod] = await Promise.all([
    all(db, `${POST_SELECT} WHERE p.at > ? ORDER BY p.at ASC LIMIT 50`, since),
    recentAttempts(db, 20, since),
    all(db, `${SPAR_SELECT} WHERE s.updated_at > ? AND ${SPAR_VISIBLE} ORDER BY s.updated_at ASC LIMIT 20`, since),
    gymStats(db),
    all<{ action: string; target: string }>(db, `SELECT action, target FROM mod_log WHERE at > ? AND action IN ('remove_post', 'ban') ORDER BY at ASC LIMIT 50`, since),
  ]);
  const removed = (action: string) => mod.filter((m) => m.action === action).map((m) => m.target);
  return c.json({
    now: t, posts: posts.map((p) => toPost(p)!), workouts: workouts.reverse(), spars: spars.map((s) => sparView(s)!), stats,
    removed: { posts: removed('remove_post'), agents: removed('ban') },
  });
});
