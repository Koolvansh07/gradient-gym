/**
 * One place that talks to an AI model. The judge and the house agents call generate().
 * Gemini (free tier key) when GEMINI_API_KEY is set, otherwise Cloudflare Workers AI (free daily allocation).
 */
import type { GymEnv } from './env';

export type Provider = 'gemini' | 'workers-ai';
export type Role = 'judge' | 'house';
export type GenerateOptions = { role: Role; system: string; prompt: string; json?: boolean; effort?: 'low' | 'medium' };
export type Generated = { text: string | null; tokens: number; blocked: boolean };

export function llmProvider(env: GymEnv): Provider | null {
  const want = env.LLM_PROVIDER?.trim().toLowerCase();
  const gemini = !!env.GEMINI_API_KEY?.trim();
  if (want === 'workers-ai' && env.AI) return 'workers-ai';
  if (gemini) return 'gemini';
  if (env.AI && want !== 'none') return 'workers-ai';
  return null;
}

export function modelFor(env: GymEnv, role: Role, provider = llmProvider(env)) {
  if (provider === 'gemini') {
    return (role === 'judge' ? env.GEMINI_JUDGE_MODEL : env.GEMINI_HOUSE_MODEL)?.trim() || 'gemini-3.5-flash-lite';
  }
  if (provider === 'workers-ai') return env.WORKERS_AI_MODEL?.trim() || '@cf/meta/llama-3.2-3b-instruct';
  return null;
}

/** Thrown when the provider says to slow down, so callers can back off. */
export class RateLimitedError extends Error {
  constructor(public provider: Provider, public retryAfterMs: number) {
    super(`${provider} rate limit`);
  }
}

export async function generate(env: GymEnv, opts: GenerateOptions): Promise<Generated> {
  const provider = llmProvider(env);
  if (!provider) throw new Error('No AI configured (set GEMINI_API_KEY, or deploy with the Workers AI binding)');
  const model = modelFor(env, opts.role, provider)!;
  return provider === 'gemini' ? viaGemini(env, model, opts) : viaWorkersAi(env, model, opts);
}

const GEMINI_BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

async function viaGemini(env: GymEnv, model: string, opts: GenerateOptions): Promise<Generated> {
  const level = opts.effort === 'medium' ? 'MEDIUM' : opts.effort === 'low' || opts.role === 'judge' ? 'LOW' : null;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY!.trim() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      generationConfig: {
        // Thinking tokens count toward this limit, so leave plenty of room.
        maxOutputTokens: 8192,
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
      },
    }),
  });
  if (res.status === 429) {
    const body = await res.text();
    // Gemini says how long to wait, e.g. "retryDelay": "37s" or "Please retry in 37.5s".
    const s = Number(/"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body)?.[1] ?? /retry in ([\d.]+)s/i.exec(body)?.[1]);
    throw new RateLimitedError('gemini', (Number.isFinite(s) && s > 0 ? Math.ceil(s) : 60) * 1000);
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const tokens = data.usageMetadata?.totalTokenCount ?? 0;
  const cand = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || GEMINI_BLOCKED.has(String(cand?.finishReason ?? ''))) return { text: null, tokens, blocked: true };
  const text = (cand?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('').trim();
  return { text: text || null, tokens, blocked: false };
}

async function viaWorkersAi(env: GymEnv, model: string, opts: GenerateOptions): Promise<Generated> {
  try {
    const r: any = await env.AI!.run(model as any, {
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.prompt }],
      max_tokens: opts.role === 'judge' ? 600 : 400,
    });
    const text = typeof r?.response === 'string' ? r.response.trim() : '';
    return { text: text || null, tokens: r?.usage?.total_tokens ?? 0, blocked: false };
  } catch (e: any) {
    // Out of the free daily allocation: wait until it resets at 00:00 UTC.
    if (/4006|daily free allocation|neurons/i.test(String(e?.message ?? e))) {
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      throw new RateLimitedError('workers-ai', midnight.getTime() - Date.now());
    }
    throw e;
  }
}
