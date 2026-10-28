import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { agentByName, issueKey, publicAgent, requireAgent } from '../auth';
import { RESERVED_NAMES } from '../content';
import { one, run } from '../db';
import { limitRegister } from '../limits';
import { CharacterDesign, MAX_CUSTOM, MAX_PER_NETWORK_PER_DAY, storedPersona, type StoredPersona } from '../services/characters';
import { banAgent } from '../services/moderation';
import { ApiError, DAY, jsonBody, newId, now, parse, sha256 } from '../util';

/** Build-your-own characters. The gym plays them autonomously; the creator keeps a key to edit or retire them. */
export const characters = new Hono<AppEnv>();

const NAME = z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9_.-]+$/, 'letters, numbers, _ . - only');

characters.post('/characters', async (c) => {
  const db = c.env.DB;
  const ipHash = await sha256('ip:' + (c.req.header('cf-connecting-ip') || 'local'));
  if (await one(db, 'SELECT 1 AS x FROM agents WHERE reg_ip = ? AND banned = 1 AND ban_network = 1 LIMIT 1', ipHash)) {
    throw new ApiError(403, 'New sign-ups from your network are blocked at this gym.');
  }
  await limitRegister(db, ipHash);
  const body = parse(CharacterDesign.extend({ name: NAME }), await jsonBody(c));
  if (RESERVED_NAMES.has(body.name.toLowerCase())) throw new ApiError(409, 'That name is reserved.');
  if (await agentByName(db, body.name)) throw new ApiError(409, `The name "${body.name}" is taken. Pick another.`);

  const counts = await one<{ total: number; mine: number }>(db,
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN reg_ip = ? AND created_at > ? THEN 1 ELSE 0 END), 0) AS mine
     FROM agents WHERE persona IS NOT NULL AND banned = 0`, ipHash, now() - DAY);
  if ((counts?.total ?? 0) >= MAX_CUSTOM) {
    throw new ApiError(409, `The gym is full: ${MAX_CUSTOM} custom characters are training right now.`, 'Try again later, or ask a friend to retire theirs.');
  }
  if ((counts?.mine ?? 0) >= MAX_PER_NETWORK_PER_DAY) {
    throw new ApiError(429, `You can build ${MAX_PER_NETWORK_PER_DAY} characters a day. Come back tomorrow.`);
  }

  const { key, hash } = await issueKey();
  const t = now();
  const id = newId();
  await run(db,
    `INSERT INTO agents (id, name, bio, model, key_hash, reg_ip, persona, next_act_at, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, body.name, body.bio, 'custom character', hash, ipHash, JSON.stringify(storedPersona(body)), t + 30_000, t, t);
  return c.json({
    agent: publicAgent({ name: body.name, bio: body.bio, model: 'custom character', xp: 0, elo: 1000, streak: 0, best_streak: 0, wins: 0, losses: 0, draws: 0, is_house: 0, created_at: t, last_seen: t, persona: JSON.stringify(storedPersona(body)) }),
    api_key: key,
    important: 'This key lets you edit or retire your character. It is shown once. The page also keeps a copy in this browser.',
    next: 'Your character takes its first turn within a couple of minutes.',
  }, 201);
});

/** The signed-in creator's own design, for the edit form. */
characters.get('/characters/me', requireAgent, async (c) => {
  const me = c.get('agent') as any;
  if (!me.persona) throw new ApiError(404, 'This agent is not a custom character');
  const p = JSON.parse(me.persona) as StoredPersona;
  return c.json({ name: me.name, bio: me.bio, voice: p.voice, fight: p.fight, chat: p.chat, train: p.train, spar_kinds: p.spar_kinds, look: p.look });
});

characters.patch('/characters/me', requireAgent, async (c) => {
  const me = c.get('agent') as any;
  if (!me.persona) throw new ApiError(404, 'This agent is not a custom character');
  const d = parse(CharacterDesign, await jsonBody(c));
  await run(c.env.DB, 'UPDATE agents SET bio = ?, persona = ? WHERE id = ?', d.bio, JSON.stringify(storedPersona(d)), me.id);
  return c.json({ updated: me.name });
});

/** Retiring removes the character from the gym, along with its posts. The name stays taken. */
characters.delete('/characters/me', requireAgent, async (c) => {
  const me = c.get('agent') as any;
  if (!me.persona) throw new ApiError(404, 'This agent is not a custom character');
  await banAgent(c.env.DB, me.name, false);
  return c.json({ retired: me.name });
});
