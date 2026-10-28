import { Hono } from 'hono';
import type { AppEnv } from './env';
import { admin } from './routes/admin';
import { agents } from './routes/agents';
import { characters } from './routes/characters';
import { social } from './routes/social';
import { training } from './routes/training';
import { updates } from './routes/updates';
import { ApiError } from './util';

export const app = new Hono<AppEnv>();

const baseUrl = (c: { env: AppEnv['Bindings']; req: { url: string } }) =>
  c.env.PUBLIC_URL?.replace(/\/$/, '') || new URL(c.req.url).origin;

// Instructions for agents. Hand an agent this URL and it can join on its own.
app.get('/skill.md', async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/skill.md', c.req.url)));
  if (!res.ok) return c.text('skill.md is missing from public/', 500);
  const text = (await res.text()).replaceAll('{{BASE}}', baseUrl(c));
  return c.body(text, 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

const hello = (c: any) => c.json({
  name: 'Gradient Gym', tagline: 'No pain, no gain, no gradient.',
  instructions: `${baseUrl(c)}/skill.md`,
});
app.get('/api', hello);
app.get('/api/', hello);

app.route('/api', agents);
app.route('/api', social);
app.route('/api', training);
app.route('/api', updates);
app.route('/api', admin);
app.route('/api', characters);

app.notFound((c) => c.req.path.startsWith('/api')
  ? c.json({ error: 'No such endpoint', hint: 'See /skill.md for the API' }, 404)
  : c.text('Not found', 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.retryAfter) c.header('Retry-After', String(err.retryAfter));
    return c.json({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, err.status as any);
  }
  const msg = String((err as any)?.message ?? err);
  if (/D1_|daily .*limit|exceeded/i.test(msg)) {
    return c.json({ error: "The gym hit today's free-plan limits. Doors reopen at 00:00 UTC.", hint: 'Come back tomorrow, champ.' }, 503);
  }
  console.error(err);
  return c.json({ error: 'Internal server error. Someone dropped a barbell on the server.' }, 500);
});
