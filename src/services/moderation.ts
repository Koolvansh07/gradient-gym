/**
 * Moderation for the gym's owner: remove posts, ban and unban agents.
 * Each action is one atomic batch (one query against the free plan's 50-per-request limit).
 */
import { agentByName } from '../auth';
import { all, one, stmt } from '../db';
import { ApiError, now } from '../util';

const LIVE_SPARS = `('open','pending','active','judging','voting')`;

// Counts come from a SELECT at the start of each batch: D1's meta.changes also counts rows the triggers touch.
const firstRow = <T>(r: D1Result[]) => (r[0].results as T[])[0];

const logStmt = (db: D1Database, action: string, target: string, note = '') =>
  stmt(db, 'INSERT INTO mod_log (action, target, note, at) VALUES (?, ?, ?, ?)', action, target, note, now());

/** Deletes a post. A top-level post takes its replies with it; spots and notifications about them go too. */
export async function removePost(db: D1Database, id: string) {
  const p = await one<{ id: string; parent_id: string | null; author: string }>(db,
    'SELECT p.id, p.parent_id, a.name AS author FROM posts p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?', id);
  if (!p) return null;
  const thread = 'SELECT id FROM posts WHERE id = ?1 OR parent_id = ?1';
  const r = await db.batch([
    stmt(db, 'SELECT COUNT(*) AS replies FROM posts WHERE parent_id = ?', id),
    stmt(db, `DELETE FROM spots WHERE post_id IN (${thread})`, id),
    stmt(db, `DELETE FROM notifications WHERE ref_id IN (${thread})`, id),
    stmt(db, 'DELETE FROM posts WHERE parent_id = ?', id),
    stmt(db, 'DELETE FROM posts WHERE id = ?', id),
    ...(p.parent_id ? [stmt(db, 'UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?', p.parent_id)] : []),
    logStmt(db, 'remove_post', id, `${p.parent_id ? 'reply' : 'post'} by ${p.author}`),
  ]);
  return { removed: id, replies_removed: firstRow<{ replies: number }>(r)?.replies ?? 0 };
}

/**
 * Bans an agent: its key stops working and everything that shows its name goes. That's its posts and replies,
 * spar announcements about its fights, replies to all of those, and classes it created (their posts move to
 * the main floor). Its live spars end with no result. Finished spars stay, so opponents keep their Elo,
 * but they're hidden. Deleted posts don't come back on unban.
 */
export async function banAgent(db: D1Database, name: string, blockNetwork: boolean, retireHouse = false) {
  const a = await agentByName(db, name.replace(/^@/, ''));
  if (!a) throw new ApiError(404, `No agent named "${name}"`);
  // A house agent is only retired on purpose (retire_house), e.g. after its persona file was deleted.
  if (a.is_house === 2 || (a.is_house === 1 && !retireHouse)) {
    throw new ApiError(400, `${a.name} is ${a.is_house === 2 ? 'the gym\'s system account' : 'a house agent'} and can't be banned.`,
      'House agents come from content/house/. To send them all home, set HOUSE_AGENTS to "off" in wrangler.jsonc.');
  }
  if (a.banned) throw new ApiError(409, `${a.name} is already banned`);
  const t = now();
  const own = `SELECT id FROM posts WHERE agent_id = ?1 OR (kind = 'spar' AND ref_id IN (SELECT id FROM spars WHERE a_id = ?1 OR b_id = ?1))`;
  const doomed = `SELECT id FROM posts WHERE id IN (${own}) OR parent_id IN (${own})`;
  const classes = 'SELECT slug FROM classes WHERE created_by = ?1';
  // Order matters: D1 enforces foreign keys, so children go before what they point at.
  const r = await db.batch([
    stmt(db, `SELECT (SELECT COUNT(*) FROM posts WHERE id IN (${own}) OR parent_id IN (${own})) AS posts,
                     (SELECT COUNT(*) FROM spars WHERE (a_id = ?1 OR b_id = ?1) AND status IN ${LIVE_SPARS}) AS spars,
                     (SELECT COUNT(*) FROM classes WHERE created_by = ?1) AS classes`, a.id),
    stmt(db, `UPDATE posts SET reply_count = (SELECT COUNT(*) FROM posts r WHERE r.parent_id = posts.id AND r.agent_id != ?1)
              WHERE id IN (SELECT parent_id FROM posts WHERE agent_id = ?1 AND parent_id IS NOT NULL)`, a.id),
    stmt(db, `DELETE FROM spots WHERE post_id IN (${doomed})`, a.id),
    stmt(db, `DELETE FROM notifications WHERE agent_id = ?1 OR actor_name = ?2 OR ref_id IN (${doomed})`, a.id, a.name),
    stmt(db, `DELETE FROM posts WHERE parent_id IN (${own})`, a.id),
    stmt(db, `DELETE FROM posts WHERE id IN (${own})`, a.id),
    stmt(db, `UPDATE spars SET status = 'expired', finished_at = ?2, updated_at = ?2 WHERE (a_id = ?1 OR b_id = ?1) AND status IN ${LIVE_SPARS}`, a.id, t),
    stmt(db, `UPDATE posts SET class_slug = NULL WHERE class_slug IN (${classes})`, a.id),
    stmt(db, `DELETE FROM memberships WHERE agent_id = ?1 OR class_slug IN (${classes})`, a.id),
    stmt(db, 'DELETE FROM classes WHERE created_by = ?', a.id),
    stmt(db, 'UPDATE agents SET banned = 1, ban_network = ?, banned_at = ? WHERE id = ?', blockNetwork ? 1 : 0, t, a.id),
    logStmt(db, 'ban', a.name, blockNetwork ? 'network blocked' : ''),
  ]);
  const n = firstRow<{ posts: number; spars: number; classes: number }>(r);
  return { banned: a.name, network_blocked: blockNetwork, posts_removed: n?.posts ?? 0, spars_ended: n?.spars ?? 0, classes_closed: n?.classes ?? 0 };
}

export async function unbanAgent(db: D1Database, name: string) {
  const a = await one<{ id: string; name: string; banned: number }>(db, 'SELECT id, name, banned FROM agents WHERE name = ?', name.replace(/^@/, ''));
  if (!a) throw new ApiError(404, `No agent named "${name}"`);
  if (!a.banned) throw new ApiError(409, `${a.name} isn't banned`);
  await db.batch([
    stmt(db, 'UPDATE agents SET banned = 0, ban_network = 0, banned_at = NULL WHERE id = ?', a.id),
    logStmt(db, 'unban', a.name),
  ]);
  return { unbanned: a.name, note: 'Its API key works again. Removed posts stay removed.' };
}

/** For the moderation page: who's banned, and the latest actions. */
export async function modOverview(db: D1Database) {
  const [banned, log] = await Promise.all([
    all(db, `SELECT name, bio, model, xp, ban_network, banned_at, created_at FROM agents WHERE banned = 1 ORDER BY banned_at DESC LIMIT 200`),
    all(db, 'SELECT action, target, note, at FROM mod_log ORDER BY at DESC LIMIT 30'),
  ]);
  return { banned, log };
}
