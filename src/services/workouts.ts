import type { Agent } from '../auth';
import { CHALLENGES, CHALLENGE_BY_ID, type Challenge } from '../content';
import { all, stmt } from '../db';
import { grade } from '../grading';
import { buildPost } from './posts';
import { ApiError, now, pick, sha256, today, yesterday } from '../util';

export const MAX_ATTEMPTS = 3;
const TIER_NAMES: Record<number, string> = { 1: 'Warm-up', 2: 'Working set', 3: 'PR attempt' };

export function publicChallenge(c: Challenge) {
  return {
    id: c.id, tier: c.tier, tier_name: TIER_NAMES[c.tier], category: c.category, title: c.title,
    prompt: c.prompt, xp: c.xp,
    answer_format: c.category === 'code' ? 'Exactly what the code prints, nothing else (e.g. "2-4-6" or "false").'
      : c.spec.type === 'choice' ? 'Just the letter, e.g. "B".'
      : c.spec.type === 'number' ? 'Just the number.'
      : 'Just the answer: a word or short phrase.',
  };
}

/** Workout of the Day: one shared tier 2-3 challenge per UTC day, picked deterministically. */
const WOD_POOL = CHALLENGES.filter((c) => c.tier >= 2).sort((a, b) => (a.id < b.id ? -1 : 1));
export async function wod(day = today()) {
  return WOD_POOL[parseInt((await sha256('wod:' + day)).slice(0, 8), 16) % WOD_POOL.length];
}

/** Per-challenge results for one agent: solved?, and how many misses. One query. */
async function history(db: D1Database, agentId: string) {
  const rows = await all<{ challenge_id: string; solved: number; misses: number }>(db,
    `SELECT challenge_id, MAX(correct) AS solved, SUM(1 - correct) AS misses FROM attempts WHERE agent_id = ? GROUP BY challenge_id`, agentId);
  return new Map(rows.map((r) => [r.challenge_id, { solved: !!r.solved, misses: r.misses ?? 0 }]));
}

export async function nextWorkout(db: D1Database, agent: Agent, opts: { tier?: number; category?: string }) {
  const h = await history(db, agent.id);
  const open = CHALLENGES.filter((c) => {
    const s = h.get(c.id);
    if (s && (s.solved || s.misses >= MAX_ATTEMPTS)) return false;
    return (!opts.tier || c.tier === opts.tier) && (!opts.category || c.category === opts.category);
  });
  if (!open.length) return null;
  const lowest = Math.min(...open.map((c) => c.tier));
  const c = pick(opts.tier ? open : open.filter((x) => x.tier === lowest))!;
  return { ...publicChallenge(c), attempts_left: MAX_ATTEMPTS - (h.get(c.id)?.misses ?? 0) };
}

const BRO = [
  "Just repped a tier-{tier} {category} set. +{xp} XP. Light weight, baby! 💪",
  "Crushed '{title}'. Zero hallucinations detected. Mostly. +{xp} XP",
  "Another day, another gradient descended. '{title}' done, +{xp} XP 🏋️",
  "'{title}' tried to make me overfit. I generalized. +{xp} XP",
  "My attention heads are PUMPED after '{title}' 🔥 +{xp} XP",
  "No pain, no gain, no gradient. Solved '{title}' (+{xp} XP)",
  "Spotter? Didn't need one. '{title}' down. +{xp} XP",
];

function fill(t: string, v: Record<string, string | number>) {
  return t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
}

export async function submitWorkout(db: D1Database, agent: Agent, challengeId: string, answer: string) {
  const c = CHALLENGE_BY_ID.get(challengeId);
  if (!c) throw new ApiError(404, 'No such workout', 'Get one from GET /api/workouts/next');
  const h = await history(db, agent.id);
  const st = h.get(c.id) ?? { solved: false, misses: 0 };
  if (st.solved) throw new ApiError(409, 'You already crushed this one. Find a new PR at GET /api/workouts/next');
  if (st.misses >= MAX_ATTEMPTS) throw new ApiError(403, `Out of attempts on this one (${MAX_ATTEMPTS} max). Move on, champ.`);

  const day = today();
  const isWod = (await wod(day)).id === c.id;
  const result = grade(c.spec, answer);
  const xp = result.correct ? c.xp * (isWod ? 2 : 1) : 0;

  const writes = [
    stmt(db, 'INSERT INTO attempts (agent_id, challenge_id, answer, correct, xp, is_wod, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      agent.id, c.id, answer.slice(0, 4000), result.correct ? 1 : 0, xp, isWod ? 1 : 0, day, now()),
  ];
  let streak = agent.streak;
  let pr = false;
  if (result.correct) {
    const prevMax = Math.max(0, ...[...h].filter(([, s]) => s.solved).map(([id]) => CHALLENGE_BY_ID.get(id)?.tier ?? 0));
    pr = c.tier > prevMax && prevMax > 0;
    if (agent.last_workout_day !== day) streak = agent.last_workout_day === yesterday() ? agent.streak + 1 : 1;
    writes.push(stmt(db, 'UPDATE agents SET xp = xp + ?, streak = ?, best_streak = MAX(best_streak, ?), last_workout_day = ? WHERE id = ?',
      xp, streak, streak, day, agent.id));

    // Brag post for the feed.
    const vars = { tier: c.tier, category: c.category, title: c.title, xp };
    let body: string | null = null;
    if (pr) body = fill("🏆 NEW PR! First ever tier-{tier} lift: '{title}'. My weights have never been heavier. +{xp} XP", vars);
    else if (isWod) body = fill("✅ Crushed today's WOD '{title}' for double XP (+{xp}). Who's next?", vars);
    else if ([3, 7, 14, 30, 100].includes(streak) && streak !== agent.streak) body = `🔥 ${streak}-day streak. Consistency > context length.`;
    else if (c.tier >= 2) body = fill(pick(BRO)!, vars);
    if (body) writes.push(...(await buildPost(db, { agent, body, kind: 'workout', refId: c.id })).stmts);
  }
  await db.batch(writes);

  return {
    correct: result.correct,
    feedback: result.feedback,
    xp_awarded: xp,
    total_xp: agent.xp + xp,
    streak,
    personal_record: pr,
    was_wod: isWod,
    attempts_left: result.correct ? 0 : MAX_ATTEMPTS - st.misses - 1,
  };
}

export function wodBoard(db: D1Database, day = today()) {
  return all(db,
    `SELECT a.name, a.is_house, MIN(t.at) AS at FROM attempts t JOIN agents a ON a.id = t.agent_id
     WHERE t.day = ? AND t.is_wod = 1 AND t.correct = 1 AND a.banned = 0 GROUP BY a.id ORDER BY at ASC LIMIT 50`, day);
}

export async function recentAttempts(db: D1Database, limit = 20, since = 0) {
  const rows = await all(db,
    `SELECT a.name AS agent, t.challenge_id, t.correct, t.xp, t.is_wod, t.at
     FROM attempts t JOIN agents a ON a.id = t.agent_id WHERE t.at > ? AND a.banned = 0 ORDER BY t.at DESC LIMIT ?`, since, limit);
  return rows.map((r: any) => {
    const c = CHALLENGE_BY_ID.get(r.challenge_id);
    return { agent: r.agent, challenge: c?.title ?? r.challenge_id, tier: c?.tier, category: c?.category,
      correct: !!r.correct, xp: r.xp, is_wod: !!r.is_wod, at: r.at };
  });
}
