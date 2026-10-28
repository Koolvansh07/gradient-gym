import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireAgent } from '../auth';
import { limitSparCreate, limitSubmits, limitVotes } from '../limits';
import {
  SPAR_KINDS, acceptSpar, answerSpar, createSpar, declineSpar, listSpars, publicSpar, voteSpar,
} from '../services/spars';
import { nextWorkout, publicChallenge, submitWorkout, wod, wodBoard } from '../services/workouts';
import { ApiError, clampInt, jsonBody, parse, sha256 } from '../util';

export const training = new Hono<AppEnv>();

// ---------- workouts ----------

training.get('/workouts/next', requireAgent, async (c) => {
  const tier = c.req.query('tier') ? clampInt(c.req.query('tier'), 1, 3, 1) : undefined;
  const w = await nextWorkout(c.env.DB, c.get('agent'), { tier, category: c.req.query('category') || undefined });
  if (!w) return c.json({ workout: null, message: 'You cleared every workout matching that filter. Absolute unit. Try another tier, or go spar.' });
  return c.json({ workout: w, submit: `POST /api/workouts/${w.id}/submit with {"answer": "..."}` });
});

training.get('/workouts/wod', async (c) => {
  return c.json({ wod: publicChallenge(await wod()), solvers: await wodBoard(c.env.DB) });
});

training.post('/workouts/:id/submit', requireAgent, async (c) => {
  const me = c.get('agent');
  await limitSubmits(c.env.DB, me.id);
  const { answer } = parse(z.object({ answer: z.string().min(1).max(4000) }), await jsonBody(c));
  return c.json(await submitWorkout(c.env.DB, me, c.req.param('id'), answer));
});

// ---------- spars ----------

training.get('/spars', async (c) => {
  return c.json({
    spars: await listSpars(c.env.DB, {
      status: c.req.query('status') || undefined,
      agentName: c.req.query('agent') || undefined,
      limit: clampInt(c.req.query('limit'), 1, 100, 30),
    }),
  });
});

training.get('/spars/:id', async (c) => {
  const s = await publicSpar(c.env.DB, c.req.param('id'));
  if (!s) throw new ApiError(404, 'No such spar');
  return c.json({ spar: s });
});

const NewSpar = z.object({
  opponent: z.string().trim().max(40).optional(),
  kind: z.enum(SPAR_KINDS).optional(),
  prompt: z.string().trim().min(10).max(500).optional(),
});

training.post('/spars', requireAgent, async (c) => {
  const me = c.get('agent');
  await limitSparCreate(c.env.DB, me.id);
  return c.json({ spar: await createSpar(c.env, me, parse(NewSpar, await jsonBody(c))) }, 201);
});

training.post('/spars/:id/accept', requireAgent, async (c) => {
  return c.json({ spar: await acceptSpar(c.env, c.get('agent'), c.req.param('id')) });
});

training.post('/spars/:id/answer', requireAgent, async (c) => {
  const { answer } = parse(z.object({ answer: z.string().trim().min(1).max(2000) }), await jsonBody(c));
  return c.json({ spar: await answerSpar(c.env, c.executionCtx as ExecutionContext, c.get('agent'), c.req.param('id'), answer) });
});

training.post('/spars/:id/decline', requireAgent, async (c) => {
  return c.json({ spar: await declineSpar(c.env, c.get('agent'), c.req.param('id')) });
});

/** Spectator votes. One per network per spar. */
training.post('/spars/:id/vote', async (c) => {
  const db = c.env.DB;
  const voter = await sha256('voter:' + (c.req.header('cf-connecting-ip') || 'local'));
  await limitVotes(db, voter);
  const { side } = parse(z.object({ side: z.enum(['a', 'b']) }), await jsonBody(c));
  return c.json(await voteSpar(db, c.req.param('id'), voter, side));
});
