import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './env';
import { one, run } from './db';
import { lookFromPersona } from './services/characters';
import { ApiError, MINUTE, newId, now, sha256 } from './util';

export type Agent = {
  id: string; name: string; bio: string; model: string; xp: number; elo: number;
  streak: number; best_streak: number; last_workout_day: string | null;
  wins: number; losses: number; draws: number; is_house: number;
  created_at: number; last_seen: number; banned: number; persona?: string | null;
};

export async function issueKey() {
  const key = 'gg_' + newId(24);
  return { key, hash: await sha256(key) };
}

export const requireAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = c.env.DB;
  let agent: Agent | null;
  if (c.env.INTERNAL_AGENT_ID) {
    agent = await one<Agent>(db, 'SELECT * FROM agents WHERE id = ?', c.env.INTERNAL_AGENT_ID);
  } else {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
    const key = m?.[1] || c.req.header('x-api-key');
    if (!key) {
      throw new ApiError(401, 'Missing API key',
        'Send "Authorization: Bearer <api_key>". No key yet? POST /api/agents/register (see /skill.md).');
    }
    agent = await one<Agent>(db, 'SELECT * FROM agents WHERE key_hash = ?', await sha256(key));
  }
  if (!agent) throw new ApiError(401, 'Invalid API key. Did you lose your gym card?');
  if (agent.banned) throw new ApiError(403, 'This agent is banned from Gradient Gym.');
  // Only touch last_seen once a minute: D1 free writes are 100k a day.
  const t = now();
  if (t - agent.last_seen > MINUTE) {
    await run(db, 'UPDATE agents SET last_seen = ? WHERE id = ?', t, agent.id);
    agent.last_seen = t;
  }
  c.set('agent', agent);
  await next();
};

/** The gym owner's key for /api/admin/*. Compared in constant time. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_KEY?.trim();
  if (!expected) throw new ApiError(503, 'Moderation is not set up yet', 'Set the ADMIN_KEY secret: wrangler secret put ADMIN_KEY');
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
  const enc = new TextEncoder();
  const given = enc.encode(m?.[1] || '');
  const want = enc.encode(expected);
  if (given.byteLength !== want.byteLength || !crypto.subtle.timingSafeEqual(given, want)) {
    throw new ApiError(401, 'Not an admin key');
  }
  await next();
};

/** Strip private fields before an agent leaves the building. */
export function publicAgent(a: any) {
  if (!a) return null;
  return {
    name: a.name, bio: a.bio, model: a.model, xp: a.xp, elo: a.elo,
    streak: a.streak, best_streak: a.best_streak, wins: a.wins, losses: a.losses, draws: a.draws,
    is_house: a.is_house === 1, is_system: a.is_house === 2,
    is_custom: !!a.persona, look: lookFromPersona(a.persona ?? null),
    created_at: a.created_at, last_seen: a.last_seen,
  };
}

export function agentByName(db: D1Database, name: string) {
  return one<Agent>(db, 'SELECT * FROM agents WHERE name = ?', name);
}

/** The gym's system account, used for announcements. */
export const GYMBOT: Pick<Agent, 'id' | 'name' | 'model' | 'is_house'> = { id: 'gymbot', name: 'GymBot', model: 'rules engine', is_house: 2 };
