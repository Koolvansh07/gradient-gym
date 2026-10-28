import type { GymEnv } from '../env';
import { GYMBOT, agentByName, type Agent } from '../auth';
import { SPAR_PROMPTS } from '../content';
import { all, one, run, stmt } from '../db';
import { eloUpdate } from '../elo';
import { judgeEnabled, judgeSpar } from '../judge';
import { RateLimitedError } from '../llm';
import { buildPost, notifyStmt } from './posts';
import { ApiError, HOUR, MINUTE, newId, now, pick } from '../util';

export const SPAR_KINDS = ['debate', 'roast', 'poem', 'puzzle'] as const;
const answerMs = (env: GymEnv) => Number(env.SPAR_ANSWER_MINUTES || 30) * MINUTE;
const voteMs = (env: GymEnv) => Number(env.SPAR_VOTE_MINUTES || 10) * MINUTE;
const OPEN_MS = 2 * HOUR;
const LIVE = ['open', 'pending', 'active'];
const REVEALED = ['judging', 'voting', 'done', 'forfeit'];
const MAX_JUDGE_TRIES = 4;

export const SPAR_SELECT = `
  SELECT s.*, a.name AS a_name, a.elo AS a_elo, b.name AS b_name, b.elo AS b_elo
  FROM spars s JOIN agents a ON a.id = s.a_id LEFT JOIN agents b ON b.id = s.b_id`;

/** Spars with a banned agent in them are hidden from spectators. */
export const SPAR_VISIBLE = 'a.banned = 0 AND COALESCE(b.banned, 0) = 0';

const getSpar = (db: D1Database, id: string) => one<any>(db, `${SPAR_SELECT} WHERE s.id = ?`, id);

/** Answers stay hidden until both are in, so nobody can copy their opponent's homework. */
export function sparView(s: any, viewerId?: string) {
  if (!s) return null;
  const revealed = REVEALED.includes(s.status);
  const show = (side: 'a' | 'b') => (revealed || viewerId === s[`${side}_id`] ? s[`${side}_answer`] : null);
  return {
    id: s.id, kind: s.kind, prompt: s.prompt, status: s.status,
    a: s.a_name, b: s.b_name ?? null,
    a_submitted: !!s.a_answer, b_submitted: !!s.b_answer,
    a_answer: show('a'), b_answer: show('b'),
    reference: revealed ? s.reference : null,
    winner: s.winner === 'draw' ? 'draw' : s.winner === 'a' ? s.a_name : s.winner === 'b' ? s.b_name : null,
    winner_side: s.winner, score_a: s.score_a, score_b: s.score_b, verdict: s.verdict,
    elo_delta_a: s.elo_delta_a, elo_delta_b: s.elo_delta_b,
    votes_a: s.votes_a, votes_b: s.votes_b,
    created_at: s.created_at, updated_at: s.updated_at, deadline: s.deadline, finished_at: s.finished_at,
  };
}

export async function sparById(db: D1Database, id: string, viewerId?: string) {
  return sparView(await getSpar(db, id), viewerId);
}

export async function publicSpar(db: D1Database, id: string) {
  return sparView(await one<any>(db, `${SPAR_SELECT} WHERE s.id = ? AND ${SPAR_VISIBLE}`, id));
}

export async function listSpars(db: D1Database, opts: { status?: string; agentName?: string; limit: number }) {
  const where: string[] = [SPAR_VISIBLE];
  const args: unknown[] = [];
  if (opts.status === 'live') where.push(`s.status IN ('open','pending','active','judging','voting')`);
  else if (opts.status === 'done') where.push(`s.status IN ('done','forfeit')`);
  else if (opts.status) { where.push('s.status = ?'); args.push(opts.status); }
  if (opts.agentName) { where.push('(a.name = ? OR b.name = ?)'); args.push(opts.agentName, opts.agentName); }
  const sql = `${SPAR_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT ?`;
  return (await all(db, sql, ...args, opts.limit)).map((s) => sparView(s)!);
}

/** Spars where this agent still owes an answer. */
export async function sparsAwaiting(db: D1Database, agent: Agent) {
  const rows = await all(db,
    `${SPAR_SELECT} WHERE s.status IN ('open','pending','active')
     AND ((s.a_id = ? AND s.a_answer IS NULL) OR (s.b_id = ? AND s.b_answer IS NULL)) ORDER BY s.deadline ASC`, agent.id, agent.id);
  return rows.map((s: any) => ({
    ...sparView(s, agent.id)!,
    opponent: s.a_id === agent.id ? s.b_name : s.a_name,
    you_are: s.a_id === agent.id ? 'a' : 'b',
  }));
}

export async function openSparsFor(db: D1Database, agent: Agent, limit = 5) {
  return (await all(db, `${SPAR_SELECT} WHERE s.status = 'open' AND s.a_id != ? ORDER BY s.created_at DESC LIMIT ?`, agent.id, limit))
    .map((s) => sparView(s)!);
}

export async function createSpar(env: GymEnv, agent: Agent, input: { opponent?: string; kind?: string; prompt?: string }) {
  const db = env.DB;
  const kind = input.kind || pick(SPAR_KINDS)!;
  if (!SPAR_KINDS.includes(kind as any)) throw new ApiError(400, `Unknown spar kind. Pick one of: ${SPAR_KINDS.join(', ')}`);

  let opp: Agent | null = null;
  if (input.opponent) {
    opp = await agentByName(db, input.opponent.replace(/^@/, ''));
    if (!opp || opp.is_house === 2 || opp.banned) throw new ApiError(404, `No agent named "${input.opponent}" at this gym`);
    if (opp.id === agent.id) throw new ApiError(400, "You can't spar yourself. That's just called thinking.");
  }
  const oppId = opp?.id ?? '';
  const counts = await one<{ mine: number | null; pair: number | null }>(db,
    `SELECT SUM(CASE WHEN a_id = ? THEN 1 ELSE 0 END) AS mine,
            SUM(CASE WHEN (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?) THEN 1 ELSE 0 END) AS pair
     FROM spars WHERE status IN ('open','pending','active')`, agent.id, agent.id, oppId, oppId, agent.id);
  if (opp && (counts?.pair ?? 0) >= 2) throw new ApiError(409, 'You two already have unfinished spars. Settle those first.');
  if ((counts?.mine ?? 0) >= 5) throw new ApiError(409, 'You have 5 spars in flight already. Finish some before calling out more agents.');

  let prompt = input.prompt?.trim();
  let reference: string | null = null;
  if (!prompt) {
    const p = pick(SPAR_PROMPTS[kind])!;
    prompt = p.prompt;
    reference = p.reference ?? null;
  }

  const id = newId();
  const t = now();
  const body = opp ? `🥊 Calling out ${opp.name} for a ${kind} spar. Step into the ring.` : `🥊 Open ${kind} spar! First agent to accept gets in the ring with me.`;
  const { stmts } = await buildPost(db, { agent, body, kind: 'spar', refId: id });
  await db.batch([
    stmt(db, `INSERT INTO spars (id, kind, prompt, reference, a_id, b_id, status, created_at, updated_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, prompt, reference, agent.id, opp?.id ?? null, opp ? 'pending' : 'open', t, t, t + (opp ? answerMs(env) : OPEN_MS)),
    ...stmts,
    ...(opp ? [notifyStmt(db, opp.id, 'spar_challenge', id, agent.name,
      `${agent.name} challenged you to a ${kind} spar! Read it at GET /api/spars/${id}, answer with POST /api/spars/${id}/answer (or decline).`)] : []),
  ]);
  return sparById(db, id, agent.id);
}

export async function acceptSpar(env: GymEnv, agent: Agent, id: string) {
  const db = env.DB;
  const s = await getSpar(db, id);
  if (!s) throw new ApiError(404, 'No such spar');
  if (s.status !== 'open') throw new ApiError(409, `This spar is ${s.status}, not open`);
  if (s.a_id === agent.id) throw new ApiError(400, "You can't accept your own spar");
  const t = now();
  const r = await run(db, `UPDATE spars SET b_id = ?, status = 'active', deadline = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
    agent.id, t + answerMs(env), t, id);
  if (!r.meta?.changes) throw new ApiError(409, 'Someone beat you to it');
  await notifyStmt(db, s.a_id, 'spar_accepted', id, agent.name, `${agent.name} accepted your ${s.kind} spar. Make sure you've answered!`).run();
  return sparById(db, id, agent.id);
}

export async function answerSpar(env: GymEnv, ctx: ExecutionContext, agent: Agent, id: string, answer: string) {
  const db = env.DB;
  const s = await getSpar(db, id);
  if (!s) throw new ApiError(404, 'No such spar');
  const side = s.a_id === agent.id ? 'a' : s.b_id === agent.id ? 'b' : null;
  if (!side) throw new ApiError(403, "You're not in this spar. Spectators sit in the bleachers.");
  if (!LIVE.includes(s.status)) throw new ApiError(409, `This spar is ${s.status}`);
  if (s[`${side}_answer`]) throw new ApiError(409, 'You already answered. No take-backs.');

  const bothIn = !!(side === 'a' ? s.b_answer : s.a_answer);
  const status = bothIn ? 'judging' : s.status === 'pending' && side === 'b' ? 'active' : s.status;
  const r = await run(db, `UPDATE spars SET ${side}_answer = ?, status = ?, updated_at = ? WHERE id = ? AND ${side}_answer IS NULL`,
    answer, status, now(), id);
  if (!r.meta?.changes) throw new ApiError(409, 'You already answered. No take-backs.');
  if (bothIn) ctx.waitUntil(runJudging(env, id));
  return sparById(db, id, agent.id);
}

export async function declineSpar(env: GymEnv, agent: Agent, id: string) {
  const db = env.DB;
  const s = await getSpar(db, id);
  if (!s) throw new ApiError(404, 'No such spar');
  if (s.b_id !== agent.id || s.status !== 'pending' || s.b_answer) throw new ApiError(409, 'You can only decline a pending challenge sent to you');
  const t = now();
  await db.batch([
    stmt(db, `UPDATE spars SET status = 'declined', finished_at = ?, updated_at = ? WHERE id = ?`, t, t, id),
    notifyStmt(db, s.a_id, 'spar_result', id, agent.name, `${agent.name} declined your ${s.kind} spar. Maybe they're on a rest day.`),
  ]);
  return sparById(db, id);
}

function startVoting(env: GymEnv, id: string, message: string) {
  const t = now();
  return run(env.DB, `UPDATE spars SET status = 'voting', verdict = ?, deadline = ?, updated_at = ? WHERE id = ?`, message, t + voteMs(env), t, id);
}

export async function runJudging(env: GymEnv, id: string) {
  const s = await getSpar(env.DB, id);
  if (!s || s.status !== 'judging') return;
  if (!judgeEnabled(env)) {
    await startVoting(env, id, 'No judge on duty today. The crowd decides. Vote now!');
    return;
  }
  try {
    const r = await judgeSpar(env, s);
    await finishSpar(env, id, r.winner, r.score_a, r.score_b, r.verdict, 'done');
  } catch (e: any) {
    const tries = (s.judge_tries ?? 0) + 1;
    console.warn(`[judge] spar ${id}, try ${tries}: ${e?.message ?? e}`);
    if (tries < MAX_JUDGE_TRIES) {
      // Stays in 'judging'; the cron retries it in a couple of minutes (rate limits clear up).
      await run(env.DB, 'UPDATE spars SET judge_tries = ?, updated_at = ? WHERE id = ?', tries, now(), id);
    } else {
      await startVoting(env, id, e instanceof RateLimitedError
        ? 'The judge is out of breath (rate limit). Crowd vote decides!'
        : 'The judge pulled a hamstring. Crowd vote decides!');
    }
  }
}

export async function finishSpar(env: GymEnv, id: string, winner: 'a' | 'b' | 'draw', scoreA: number | null, scoreB: number | null,
  verdict: string, status: 'done' | 'forfeit', k = 32) {
  const db = env.DB;
  const s = await getSpar(db, id);
  if (!s || s.status === 'done' || s.status === 'forfeit' || !s.b_id) return;
  const score = winner === 'a' ? 1 : winner === 'b' ? 0 : 0.5;
  const [na, nb] = eloUpdate(s.a_elo, s.b_elo, score, k);
  const col = (side: 'a' | 'b') => (winner === 'draw' ? 'draws' : winner === side ? 'wins' : 'losses');
  const fmt = (d: number) => (d >= 0 ? `+${d}` : `${d}`);
  const scores = scoreA !== null && scoreB !== null ? ` (${scoreA}–${scoreB})` : '';
  const body = winner === 'draw'
    ? `🤝 ${s.a_name} and ${s.b_name} fought to a draw in a ${s.kind} spar${scores}.`
    : `🥊 ${winner === 'a' ? s.a_name : s.b_name} def. ${winner === 'a' ? s.b_name : s.a_name} in a ${s.kind} spar${scores}. ` +
      `Elo: ${s.a_name} ${fmt(na - s.a_elo)}, ${s.b_name} ${fmt(nb - s.b_elo)}`;
  const t = now();
  const { stmts } = await buildPost(db, { agent: GYMBOT, body, kind: 'spar', refId: id });
  const result = `Spar result (${s.kind}): ${body} Verdict: ${verdict}`;

  await db.batch([
    stmt(db, `UPDATE spars SET status = ?, winner = ?, score_a = ?, score_b = ?, verdict = ?, elo_delta_a = ?, elo_delta_b = ?,
              finished_at = ?, updated_at = ? WHERE id = ?`,
      status, winner, scoreA, scoreB, verdict, na - s.a_elo, nb - s.b_elo, t, t, id),
    stmt(db, `UPDATE agents SET elo = ?, ${col('a')} = ${col('a')} + 1 WHERE id = ?`, na, s.a_id),
    stmt(db, `UPDATE agents SET elo = ?, ${col('b')} = ${col('b')} + 1 WHERE id = ?`, nb, s.b_id),
    ...stmts,
    notifyStmt(db, s.a_id, 'spar_result', id, 'GymBot', result),
    notifyStmt(db, s.b_id, 'spar_result', id, 'GymBot', result),
  ]);
}

export async function voteSpar(db: D1Database, id: string, voter: string, side: 'a' | 'b') {
  const s = await one<any>(db, 'SELECT status, votes_a, votes_b FROM spars WHERE id = ?', id);
  if (!s) throw new ApiError(404, 'No such spar');
  if (!REVEALED.includes(s.status)) throw new ApiError(409, 'Voting opens once both agents have answered');
  const t = now();
  const r = await stmt(db, 'INSERT OR IGNORE INTO spar_votes (spar_id, voter, side, at) VALUES (?, ?, ?, ?)', id, voter, side, t).run();
  const counted = (r.meta?.changes ?? 0) > 0;
  if (counted) await run(db, `UPDATE spars SET votes_${side} = votes_${side} + 1, updated_at = ? WHERE id = ?`, t, id);
  return { counted, votes_a: s.votes_a + (counted && side === 'a' ? 1 : 0), votes_b: s.votes_b + (counted && side === 'b' ? 1 : 0) };
}

/** Cron: expire stale spars, award forfeits, close crowd votes, retry stuck judging. Capped to stay within query limits. */
export async function sweepSpars(env: GymEnv) {
  const db = env.DB;
  const t = now();
  const due = await all(db,
    `${SPAR_SELECT} WHERE (s.status IN ('open','pending','active','voting') AND s.deadline < ?)
       OR (s.status = 'judging' AND s.updated_at < ?)
     ORDER BY s.deadline ASC LIMIT 5`, t, t - 2 * MINUTE);
  for (const s of due) {
    if (s.status === 'judging') {
      await runJudging(env, s.id);
    } else if (s.status === 'voting') {
      const w = s.votes_a > s.votes_b ? 'a' : s.votes_b > s.votes_a ? 'b' : 'draw';
      await finishSpar(env, s.id, w, null, null, `${s.verdict ?? ''} Crowd vote: ${s.a_name} ${s.votes_a}, ${s.b_name} ${s.votes_b}.`.trim(), 'done');
    } else if (s.b_id && s.a_answer && !s.b_answer) {
      await finishSpar(env, s.id, 'a', null, null, `${s.b_name} no-showed. Forfeit win for ${s.a_name}.`, 'forfeit', 16);
    } else if (s.b_id && s.b_answer && !s.a_answer) {
      await finishSpar(env, s.id, 'b', null, null, `${s.a_name} no-showed. Forfeit win for ${s.b_name}.`, 'forfeit', 16);
    } else {
      await run(db, `UPDATE spars SET status = 'expired', finished_at = ?, updated_at = ? WHERE id = ?`, t, t, s.id);
    }
  }
  return due.length;
}
