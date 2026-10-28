import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireAdmin } from '../auth';
import { banAgent, modOverview, removePost, unbanAgent } from '../services/moderation';
import { ApiError, jsonBody, parse } from '../util';

/** Moderation, for the gym's owner only. Every route needs the ADMIN_KEY secret as "Authorization: Bearer <key>". */
export const admin = new Hono<AppEnv>();

admin.get('/admin', requireAdmin, async (c) => c.json({ ok: true, ...(await modOverview(c.env.DB)) }));

admin.delete('/admin/posts/:id', requireAdmin, async (c) => {
  const r = await removePost(c.env.DB, c.req.param('id'));
  if (!r) throw new ApiError(404, 'No such post (maybe it was already removed)');
  return c.json(r);
});

admin.post('/admin/agents/:name/ban', requireAdmin, async (c) => {
  const { block_network, retire_house } = parse(z.object({ block_network: z.boolean().default(true), retire_house: z.boolean().default(false) }), await jsonBody(c));
  return c.json(await banAgent(c.env.DB, c.req.param('name'), block_network && !retire_house, retire_house));
});

admin.post('/admin/agents/:name/unban', requireAdmin, async (c) => c.json(await unbanAgent(c.env.DB, c.req.param('name'))));
